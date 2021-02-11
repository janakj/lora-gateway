
export default interface Message {
    id         : string;          // Globally unique id of the message
    eui        : string;          // The address of the device
    timestamp  : string;          // Message timestamp (ISO format)
    received   : string;          // Timestamp when the message was first received by the endpoint (ISO format)
    encrypted? : boolean;         // Whether the payload is encrypted
    data       : string;          // Base64 encoded payloads
    origin?    : object | string; // The original message as received from the LoRa network
}


export function isMessage(arg: any): arg is Message {
    return typeof arg.id === 'string' &&
        typeof arg.eui === 'string' && arg.eui.match(/[0-9A-F]{16}/) &&
        typeof arg.timestamp === 'string' &&
        (typeof arg.encrypted === 'undefined' || typeof arg.encrypted === 'boolean') &&
        typeof arg.data === 'string' &&
        (typeof arg.attributes === 'undefined' || typeof arg.data === 'object');
}
