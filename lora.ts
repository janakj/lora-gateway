/* eslint-disable no-bitwise */
import { createCipheriv } from 'crypto';


export function decrypt(ciphertext: Buffer, devaddr: string, appskey: string, seq: number) {
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(appskey, 'hex'), null);
    cipher.setAutoPadding(false);

    const dst = Buffer.alloc(ciphertext.length);

    const addr = Buffer.from(devaddr, 'hex');
    const block_a = new Uint8Array([
        0x01, 0x00, 0x00, 0x00, 0x00, 0,
        addr[3], addr[2], addr[1], addr[0],
        seq & 0xff, (seq >> 8) & 0xff, (seq >> 16) & 0xff, (seq >> 24) & 0xff,
        0x00,
        0x00
    ]);

    for(let i = 0; i < ciphertext.length; i += 16) {
        const left = Math.min(ciphertext.length - i, 16);
        block_a[15] = (i + 1) & 0xff;

        const block_s = cipher.update(block_a);
        if (left < 16) cipher.final();

        for (let j = 0; j < left; j++)
        dst[i + j] = ciphertext[i + j] ^ block_s[j];
    }

    return dst;
}
