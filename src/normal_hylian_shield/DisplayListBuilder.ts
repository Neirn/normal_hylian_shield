

export class DisplayListBuilder {

    private dlBuf = Buffer.alloc(0);

    pushDE01(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDE010000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf = Buffer.concat([this.dlBuf, command]);
    }

    pushDE00(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDE000000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf = Buffer.concat([this.dlBuf, command]);
    }

    pushMtx(addr: number) {
        let command = Buffer.alloc(8);
        command.writeUInt32BE(0xDA380000);
        command.writeUInt32BE(addr, 4);
        this.dlBuf = Buffer.concat([this.dlBuf, command]);
    }

    popMtx() {
        this.dlBuf = Buffer.concat([this.dlBuf, Buffer.from("D838000200000040", 'hex')]);
    }

    pushDF() {
        this.dlBuf = Buffer.concat([this.dlBuf, Buffer.from("DF00000000000000", 'hex')]);
    }

    getDisplayList() {
        let buf = Buffer.alloc(this.dlBuf.byteLength);
        this.dlBuf.copy(buf);
        return buf;
    }

    size() {
        return this.dlBuf.length;
    }

}
