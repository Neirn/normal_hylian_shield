import { SmartBuffer } from 'smart-buffer'

export class DisplayListBuilder {

    private dlBuf = new SmartBuffer();
    pushDE01(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDE010000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf.writeBuffer(command);
    }

    pushDE00(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDE000000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf.writeBuffer(command);
    }

    pushMtx(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDA380000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf.writeBuffer(command);
    }

    popMtx() {
        this.dlBuf.writeBuffer(Buffer.from("D838000200000040", 'hex'));
    }

    pushDF() {
        this.dlBuf.writeBuffer(Buffer.from("D838000200000040", 'hex'));
    }

    getDisplayList() {
        return Buffer.from(this.dlBuf.toBuffer);
    }

    size() {
        return this.dlBuf.length;
    }

}
