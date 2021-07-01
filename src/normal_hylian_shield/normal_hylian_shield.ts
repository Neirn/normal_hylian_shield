import { EventHandler, EventsClient } from 'modloader64_api/EventHandler';
import { IPlugin, IModLoaderAPI } from 'modloader64_api/IModLoaderAPI';
import { IOOTCore, OotEvents } from 'modloader64_api/OOT/OOTAPI';
import { InjectCore } from 'modloader64_api/CoreInjection';
import { onViUpdate } from 'modloader64_api/PluginLifecycle';
import { readJSONSync, existsSync, writeJSONSync } from 'fs-extra';
import { resolve } from 'path';
import { Z64OnlineEvents, Z64Online_LocalModelChangeProcessEvt } from './OoTOAPI';
import { DisplayListBuilder } from './DisplayListBuilder';
import { number_ref, bool_ref } from 'modloader64_api/Sylvain/ImGui';

const SEG_06 = 0x06000000;

const SETTINGS_FILE = 'nhs_settings.json';

const enum SHIELD_MODE {
    CHILD_SHIELD,
    ADULT_SHIELD_RESIZED
}

interface IMatrixRef {
    t_x: number_ref,
    t_y: number_ref,
    t_z: number_ref,
    r_x: number_ref,
    r_y: number_ref,
    r_z: number_ref,
    s: number_ref
}

interface INHS_Settings {
    mode?: SHIELD_MODE,
    hand_matrix?: IMatrixRef,
    back_matrix?: IMatrixRef
}

const enum CODE_PTRs {
    HS_BACK_HI = 0x800F781C,
    HS_BACK_LOD = 0x800F7824,
    HS_HAND_HI = 0x800F77DC,
    HS_HAND_LOD = 0x800F77E4,
    BGS_BACK_HI = 0x800F787C,
    BGS_BACK_LO = 0x800F7884
}

const enum CHILD_OFFSETS {
    HS_KS_BACK = 0x5290,
    SWORD_SHEATHED = 0x5248,
    RFIST = 0x5170,
    HS_BACK = 0x51B8,
    SHIELD_MTX = 0x5050,
    HS_SHEATH = 0x52C0
}

const enum ADULT_OFFSETS {
    HS_HAND = 0x5160,
    HS_MATRIX = 0x5050
}

function FTOFIX32(x: number) {
    let output: number = ((x) * 65536.0);
    return output;
}

function guMtxF2L(mf: number[][]): any {
    let e1: number = 0, e2: number = 0;
    let ai: number = 0, af: number = 0;

    let buf: Buffer = Buffer.alloc(0x40);
    let offset: number = 0;
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++) {
            e1 = FTOFIX32(mf[i][j * 2]);
            e2 = FTOFIX32(mf[i][(j * 2) + 1]);
            ai = (e1 & 0xFFFF0000) | ((e2 >> 16) & 0xFFFF);
            buf.writeInt32BE(ai, offset);
            offset += 0x4;
        }
    }
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++) {
            e1 = FTOFIX32(mf[i][j * 2]);
            e2 = FTOFIX32(mf[i][(j * 2) + 1]);
            af = ((e1 << 16) & 0xFFFF0000) | (e2 & 0xFFFF);
            buf.writeInt32BE(af, offset);
            offset += 0x4;
        }
    }
    return buf;
}

function guRTSF(r: number, p: number, h: number, x: number, y: number, z: number, s: number): number[][] {
    let sinr: number, sinp: number, sinh: number, cosr: number, cosp: number, cosh: number;
    let mf: number[][] = [[], [], [], []];

    r = r * (Math.PI / 180);
    p = p * (Math.PI / 180);
    h = h * (Math.PI / 180);
    sinr = Math.sin(r);//Sine Roll
    cosr = Math.cos(r);//Cosine Roll
    sinp = Math.sin(p);//Sine Pitch
    cosp = Math.cos(p);//Cosine Pitch
    sinh = Math.sin(h);//Sine Heading
    cosh = Math.cos(h);//Cosine Heading

    mf[0][0] = (cosp * cosh) * s;
    mf[0][1] = (cosp * sinh) * s;
    mf[0][2] = (-sinp) * s;
    mf[0][3] = 0.0;

    mf[1][0] = (sinr * sinp * cosh - cosr * sinh) * s;
    mf[1][1] = (sinr * sinp * sinh + cosr * cosh) * s;
    mf[1][2] = (sinr * cosp) * s;
    mf[1][3] = 0.0;

    mf[2][0] = (cosr * sinp * cosh + sinr * sinh) * s;
    mf[2][1] = (cosr * sinp * sinh - sinr * cosh) * s;
    mf[2][2] = (cosr * cosp) * s;
    mf[2][3] = 0.0;

    mf[3][0] = x;
    mf[3][1] = y;
    mf[3][2] = z;
    mf[3][3] = 1.0;

    return mf;
}

function ref2RTSF(matrix_ref: IMatrixRef) {
    return guRTSF(matrix_ref.r_x[0], matrix_ref.r_y[0], matrix_ref.r_z[0], matrix_ref.t_x[0], matrix_ref.t_y[0], matrix_ref.t_z[0], matrix_ref.s[0]);
}

class NormalHylianShield implements IPlugin {

    ModLoader!: IModLoaderAPI;
    @InjectCore()
    core!: IOOTCore;
    offset!: number;
    adultShieldAddr = -1;
    scaleMtxPtr!: number;
    adultShieldPtr!: number;
    rescaledShieldPtr!: number;
    childShieldHandPtr!: number;
    adultShieldSmallHandPtr!: number;
    adultShieldSmallBackPtr!: number;
    childHandShieldMtxPtr!: number;
    mallocSize!: number;
    handMtx!: IMatrixRef;
    adultResizedMtx!: IMatrixRef;
    startupMode!: SHIELD_MODE;
    handAdvancedOpen = [false];
    resizeAdvancedOpen = [false];

    preinit() { }
    init() {
        this.mallocSize = this.prepareMalloc();

        if (existsSync(resolve(SETTINGS_FILE))) {
            try {
                let settings: INHS_Settings = readJSONSync(resolve(SETTINGS_FILE));

                if (settings.mode !== undefined && settings.back_matrix && settings.hand_matrix) {
                    this.handMtx = settings.hand_matrix;
                    this.adultResizedMtx = settings.back_matrix;
                    this.startupMode = settings.mode;
                }

            } catch (error) {
                this.ModLoader.logger.error(error.message);
                this.ModLoader.logger.error("Error reading NHS settings! Loading default values...")
            }
        } else this.resetDefaults();
    }
    postinit() { }
    onTick() { }

    updateHandMatrix() {
        this.ModLoader.emulator.rdramWriteBuffer(this.childHandShieldMtxPtr, guMtxF2L(ref2RTSF(this.handMtx)));
    }

    updateScaleMatrix() {
        this.ModLoader.emulator.rdramWriteBuffer(this.scaleMtxPtr, guMtxF2L(ref2RTSF(this.adultResizedMtx)));
    }

    resetDefaults() {
        this.handMtx = {
            t_x: [512],
            t_y: [-335],
            t_z: [0],
            r_x: [0],
            r_y: [0],
            r_z: [155],
            s: [1]
        }

        this.adultResizedMtx = {
            t_x: [0],
            t_y: [0],
            t_z: [0],
            r_x: [0],
            r_y: [0],
            r_z: [0],
            s: [1.0]
        }

        this.startupMode = SHIELD_MODE.CHILD_SHIELD;
    }

    updateAdultShield() {
        if (this.adultShieldAddr === -1) {
            this.ModLoader.emulator.rdramWriteBuffer(this.adultShieldPtr, Buffer.from("DF00000000000000", 'hex'));
        }
        else {
            let fullShield = new DisplayListBuilder();
            fullShield.pushDE01(this.adultShieldAddr);
            this.ModLoader.emulator.rdramWriteBuffer(this.adultShieldPtr, fullShield.getDisplayList());
        }
    }

    @EventHandler(OotEvents.ON_SAVE_LOADED)
    onSaveLoaded() {

        this.updateHandMatrix();
        this.updateScaleMatrix();
        this.updateAdultShield();

        // small adult shield
        let smallShield = new DisplayListBuilder();
        smallShield.pushMtx(this.scaleMtxPtr);
        smallShield.pushDE00(this.adultShieldPtr)
        smallShield.popMtx();
        smallShield.pushDF();
        this.ModLoader.emulator.rdramWriteBuffer(this.rescaledShieldPtr, smallShield.getDisplayList())

        // child hylian shield in hand
        let childHandDL = new DisplayListBuilder();
        childHandDL.pushMtx(this.childHandShieldMtxPtr);
        childHandDL.pushDE00(CHILD_OFFSETS.HS_BACK + SEG_06);
        childHandDL.popMtx();
        childHandDL.pushDE01(CHILD_OFFSETS.RFIST + SEG_06);
        this.ModLoader.emulator.rdramWriteBuffer(this.childShieldHandPtr, childHandDL.getDisplayList());

        // adult hylian shield in hand
        let adultHandSmallDL = new DisplayListBuilder();
        adultHandSmallDL.pushDE00(this.rescaledShieldPtr);
        adultHandSmallDL.pushDE01(CHILD_OFFSETS.RFIST + SEG_06);
        this.ModLoader.emulator.rdramWriteBuffer(this.adultShieldSmallHandPtr, adultHandSmallDL.getDisplayList());

        // adult hylian shield on back
        let adultBackSmallDL = new DisplayListBuilder();
        adultBackSmallDL.pushMtx(CHILD_OFFSETS.SHIELD_MTX + SEG_06);
        adultBackSmallDL.pushDE00(this.rescaledShieldPtr);
        adultBackSmallDL.popMtx();
        adultBackSmallDL.pushDE01(CHILD_OFFSETS.SWORD_SHEATHED + SEG_06);
        this.ModLoader.emulator.rdramWriteBuffer(this.adultShieldSmallBackPtr, adultBackSmallDL.getDisplayList());

        switch (this.startupMode) {
            case SHIELD_MODE.CHILD_SHIELD:
                this.equipChildShield();
                break;

            case SHIELD_MODE.ADULT_SHIELD_RESIZED:
                this.equipAdultShieldSmall();
                break;

            default:
                break;
        }
    }

    @EventHandler(EventsClient.ON_HEAP_READY)
    onHeapReady() {
        this.offset = this.ModLoader.heap!.malloc(this.mallocSize);
        this.scaleMtxPtr += this.offset;
        this.childHandShieldMtxPtr += this.offset;
        this.adultShieldPtr += this.offset;
        this.rescaledShieldPtr += this.offset;
        this.childShieldHandPtr += this.offset;
        this.adultShieldSmallHandPtr += this.offset;
        this.adultShieldSmallBackPtr += this.offset;
    }

    @EventHandler(Z64OnlineEvents.LOCAL_MODEL_CHANGE_FINISHED)
    onFinished(evt: Z64Online_LocalModelChangeProcessEvt) {
        this.adultShieldAddr = evt.adult.pointer + ADULT_OFFSETS.HS_HAND;
        this.updateAdultShield();
    }

    equipChildShield() {
        this.equipShield(this.childShieldHandPtr, CHILD_OFFSETS.HS_KS_BACK + SEG_06, CHILD_OFFSETS.HS_SHEATH + SEG_06);
        this.startupMode = SHIELD_MODE.CHILD_SHIELD;
    }

    equipAdultShieldSmall() {
        this.equipShield(this.adultShieldSmallHandPtr, this.adultShieldSmallBackPtr, this.adultShieldSmallBackPtr);
        this.startupMode = SHIELD_MODE.ADULT_SHIELD_RESIZED;
    }

    equipShield(handShieldAddr: number, backShieldAddr: number, bgsShieldAddr: number) {
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.HS_HAND_HI, handShieldAddr);
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.HS_HAND_LOD, handShieldAddr);
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.HS_BACK_HI, backShieldAddr);
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.HS_BACK_LOD, backShieldAddr);
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.BGS_BACK_HI, bgsShieldAddr);
        this.ModLoader.emulator.rdramWrite32(CODE_PTRs.BGS_BACK_LO, bgsShieldAddr);
        this.ModLoader.emulator.invalidateCachedCode();
    }

    prepareMalloc() {

        this.childHandShieldMtxPtr = 0;
        this.scaleMtxPtr = 0x40;
        this.adultShieldPtr = 0x80;

        let result = 0x88;

        // small adult shield
        this.rescaledShieldPtr = result;
        let smallShield = new DisplayListBuilder();
        smallShield.pushMtx(0);
        smallShield.pushDE00(0)
        smallShield.popMtx();
        smallShield.pushDF();
        result += smallShield.size();

        // child hylian shield in hand
        this.childShieldHandPtr = result;
        let childHandDL = new DisplayListBuilder();
        childHandDL.pushMtx(0);
        childHandDL.pushDE00(CHILD_OFFSETS.HS_BACK + SEG_06);
        childHandDL.popMtx();
        childHandDL.pushDE01(CHILD_OFFSETS.RFIST + SEG_06);
        result += childHandDL.size();

        // adult hylian shield in hand
        this.adultShieldSmallHandPtr = result;
        let adultHandSmallDL = new DisplayListBuilder();
        adultHandSmallDL.pushDE00(0);
        adultHandSmallDL.pushDE01(CHILD_OFFSETS.RFIST + SEG_06);
        result += adultHandSmallDL.size();

        // adult hylian shield on back
        this.adultShieldSmallBackPtr = result;
        let adultBackSmallDL = new DisplayListBuilder();
        adultBackSmallDL.pushMtx(CHILD_OFFSETS.SHIELD_MTX + SEG_06);
        adultBackSmallDL.pushDE00(0);
        adultBackSmallDL.popMtx();
        adultBackSmallDL.pushDE01(CHILD_OFFSETS.SWORD_SHEATHED + SEG_06);
        result += adultBackSmallDL.size();

        return result;
    }

    @onViUpdate()
    onViUpdate() {
        if (this.ModLoader.ImGui.beginMainMenuBar()) {
            if (this.ModLoader.ImGui.beginMenu("Mods")) {
                if (this.ModLoader.ImGui.beginMenu("Normal Hylian Shield")) {

                    if (this.ModLoader.ImGui.beginMenu("Mode")) {
                        if (this.ModLoader.ImGui.menuItem("Use Child Shield", undefined, this.startupMode === SHIELD_MODE.CHILD_SHIELD)) {
                            this.ModLoader.utils.setTimeoutFrames(() => {
                                this.equipChildShield();
                            }, 1);
                        }

                        if (this.ModLoader.ImGui.menuItem("Use Adult Shield", undefined, this.startupMode === SHIELD_MODE.ADULT_SHIELD_RESIZED)) {
                            this.ModLoader.utils.setTimeoutFrames(() => {
                                this.equipAdultShieldSmall();
                            }, 1);
                        }

                        this.ModLoader.ImGui.endMenu();
                    }

                    if (this.ModLoader.ImGui.beginMenu("Child Shield Transformation")) {
                        this.setupSliders(this.handMtx, "##handmtxnhs", SHIELD_MODE.CHILD_SHIELD);
                        if (this.ModLoader.ImGui.menuItem("Set Values Directly", undefined, this.handAdvancedOpen[0])) {
                            this.handAdvancedOpen[0] = true;
                        }
                        this.ModLoader.ImGui.menuItem("These values will only affect the shield when it is in your hand.", undefined, undefined, false);
                        this.ModLoader.ImGui.endMenu();
                    }

                    if (this.ModLoader.ImGui.beginMenu("Adult Shield Transformation")) {
                        this.setupSliders(this.adultResizedMtx, "##adultresizednhs", SHIELD_MODE.ADULT_SHIELD_RESIZED);
                        if (this.ModLoader.ImGui.menuItem("Set Values Directly", undefined, this.resizeAdvancedOpen[0])) {
                            this.resizeAdvancedOpen[0] = true;
                        }
                        this.ModLoader.ImGui.menuItem("These values will always affect the shield.", undefined, undefined, false);
                        this.ModLoader.ImGui.endMenu();
                    }

                    if (this.ModLoader.ImGui.menuItem("Reset Settings")) {
                        this.ModLoader.utils.setTimeoutFrames(() => {
                            this.resetDefaults();
                            this.updateHandMatrix();
                            this.updateScaleMatrix();
                        }, 1);
                    }

                    if (this.ModLoader.ImGui.menuItem("Save Settings")) {
                        this.ModLoader.utils.setTimeoutFrames(() => {
                            writeJSONSync(SETTINGS_FILE, {
                                mode: this.startupMode,
                                hand_matrix: this.handMtx,
                                back_matrix: this.adultResizedMtx
                            });
                        }, 1);
                    }

                    this.ModLoader.ImGui.endMenu();
                }
                this.ModLoader.ImGui.endMenu();
            }
            this.ModLoader.ImGui.endMainMenuBar();
        }

        this.advancedMtxWindow(this.handMtx, "Advanced Child Matrix Settings", this.handAdvancedOpen, SHIELD_MODE.CHILD_SHIELD);
        this.advancedMtxWindow(this.adultResizedMtx, "Advanced Adult Matrix Settings", this.resizeAdvancedOpen, SHIELD_MODE.ADULT_SHIELD_RESIZED);
    }

    addSlider(menuItemName: string, sliderID: string, numberRef: number[], min: number, max: number, mode: SHIELD_MODE): void {
        if (this.ModLoader.ImGui.beginMenu(menuItemName)) {
            if (this.ModLoader.ImGui.sliderFloat(sliderID, numberRef, min, max)) {
                this.ModLoader.utils.setTimeoutFrames(() => {
                    if (mode === SHIELD_MODE.CHILD_SHIELD) {
                        this.updateHandMatrix();
                    }
                    else this.updateScaleMatrix();
                }, 1);
            }
            this.ModLoader.ImGui.endMenu();
        }
    }

    setupSliders(mtx: IMatrixRef, sliderID: string, mode: SHIELD_MODE) {
        this.addSlider("Rot X", sliderID, mtx.r_x, -360, 360, mode);
        this.addSlider("Rot Y", sliderID, mtx.r_y, -360, 360, mode);
        this.addSlider("Rot Z", sliderID, mtx.r_z, -360, 360, mode);
        this.addSlider("Trans X", sliderID, mtx.t_x, -1000, 1000, mode);
        this.addSlider("Trans Y", sliderID, mtx.t_y, -1000, 1000, mode);
        this.addSlider("Trans Z", sliderID, mtx.t_z, -1000, 1000, mode);
        this.addSlider("Scale", sliderID, mtx.s, -5, 5, mode);
    }

    advancedMtxWindow(mtx: IMatrixRef, windowName: string, open: bool_ref, mode: SHIELD_MODE) {
        if (open[0]) {
            if (this.ModLoader.ImGui.begin(windowName, open)) {
                if (
                    this.ModLoader.ImGui.inputFloat("X Rotation", mtx.r_x) ||
                    this.ModLoader.ImGui.inputFloat("Y Rotation", mtx.r_y) ||
                    this.ModLoader.ImGui.inputFloat("Z Rotation", mtx.r_z) ||
                    this.ModLoader.ImGui.inputFloat("X Translation", mtx.t_x) ||
                    this.ModLoader.ImGui.inputFloat("Y Translation", mtx.t_y) ||
                    this.ModLoader.ImGui.inputFloat("Z Translation", mtx.t_z) ||
                    this.ModLoader.ImGui.inputFloat("Scale", mtx.s)
                ) {
                    this.ModLoader.utils.setTimeoutFrames(() => {
                        if (mode === SHIELD_MODE.CHILD_SHIELD) {
                            this.updateHandMatrix();
                        }
                        else this.updateScaleMatrix();
                    }, 1);
                }
            }

            this.ModLoader.ImGui.end();
        }
    }

}

module.exports = NormalHylianShield;