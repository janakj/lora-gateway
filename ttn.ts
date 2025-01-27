import debug from 'debug';
import express from 'express';
import { UnauthorizedError, NotFoundError, jsonify, BadRequestError } from '@janakj/lib/http';
import Database from './db.js';
import Message from './message.js';
import { Arguments, NetworkConfig, TtnNetworkConfig, isTtnNetworkConfig } from './args.js';

const dbg = debug('lora:ttn');


interface EndDeviceIds {
    device_id: string;           // Device ID
    application_ids: {
        application_id: string;  // Application ID
    }
    dev_eui: string;   // DevEUI of the end device
    join_eui: string;  // JoinEUI of the end device (also known as AppEUI in LoRaWAN versions below 1.1)
    dev_addr: string;  // Device address known by the Network Server
}


interface Location {
    latitude: number;   // Location latitude
    longitude: number;  // Location longitude
    altitude: number;   // Location altitude
    source: string;     // Location source. SOURCE_REGISTRY is the location from the Identity Server.
}


interface RxMetadata {
    gateway_ids: {
        gateway_id: string;  // Gateway ID
        eui: string;         // Gateway EUI
    }
    time: string;            // ISO 8601 UTC timestamp at which the uplink has been received by the gateway
    timestamp: number;       // Timestamp of the gateway concentrator when the message has been received
    rssi: number;            // Received signal strength indicator (dBm)
    channel_rssi: number;    // Received signal strength indicator of the channel (dBm)
    snr: number;             // Signal-to-noise ratio (dB)
    uplink_token: string;    // Uplink token injected by gateway, Gateway Server or fNS
    channel_index: number;   // Index of the gateway channel that received the message
    location: Location;      // Gateway location metadata (only for gateways with location set to public)
}


interface Settings {
    data_rate: {                       // Data rate settings
        lora: {                        // LoRa modulation settings
            bandwidth: number;         // Bandwidth (Hz)
            spreading_factor: number;  // Spreading factor
        }
    },
    coding_rate: string; // LoRa coding rate
    frequency: string;   // Frequency (Hz)
}


interface UplinkMessage {
    rx_metadata: RxMetadata[]; // A list of metadata for each antenna of each gateway that received this message
    session_key_id: string;    // Join Server issued identifier for the session keys used by this uplink
    f_cnt: number;             // Frame counter
    f_port: number;            // Frame port
    frm_payload: string;       // Frame payload (Base64)
    decoded_payload?: any;     // Decoded payload object, decoded by the device payload formatter
    settings: Settings;        // Settings for the transmission
    received_at: string;       // ISO 8601 UTC timestamp at which the uplink has been received by the Network Server
    consumed_airtime: string;  // Time-on-air, calculated by the Network Server using payload size and transmission settings
    locations: {               // End device location metadata
        user: Location;
    };
}


interface TtnMessage {
    end_device_ids: EndDeviceIds;
    correlation_ids: string[];      // Correlation identifiers of the message
    received_at: string;            // ISO 8601 UTC timestamp at which the message has been received by the Application Server
    uplink_message: UplinkMessage;
    simulated: boolean;             // Signals if the message is coming from the Network Server or is simulated.
}


export default function (args: Arguments, _db: Database, onMessage: (msg: Message) => void | Promise<void>) {
    async function processMessage(network: string, src: TtnMessage) {
        if (src.simulated) {
            dbg('Skipping simulated message');
            return;
        }

        // Submit the message to upper layers. Construct a unique message id
        // from the string that uniquely identifies the network, the sequence
        // number and timestamp assigned to the message by the network server.
        await onMessage({
            id        : `${network}:${src.uplink_message.received_at}:${src.uplink_message.f_cnt}`,
            eui       : src.end_device_ids.dev_eui,
            timestamp : new Date(src.uplink_message.received_at).toISOString(),
            received  : new Date().toISOString(),
            data      : src.uplink_message.frm_payload, // The payload we get from TTN is already Base64 encoded
            origin    : JSON.parse(JSON.stringify(src)),
            encrypted : false // No way to tell whether TTN payload is encrypted or descrypted, assume latter
        } as Message);
    }

    const networks: Record<string, TtnNetworkConfig> = JSON.parse(JSON.stringify(args.networks));
    Object.entries<NetworkConfig>(networks).forEach(([name, value]) => {
        if (!isTtnNetworkConfig(value)) delete networks[name];
    });

    const api = express.Router();
    api.use(express.json());

    api.post('/:name', jsonify(async ({ body, headers, params }, res) => {
        const network = networks[params.name];
        if (network === undefined)
            throw new NotFoundError(`Unknown network name`);

        const { authorization } = network.push || {};

        if (authorization) {
            const v = (headers.authorization || '').trim().split(' ');
            if (v.length !== 2
                || v[0] !== 'Bearer'
                || v[1] !== authorization)
                throw new UnauthorizedError('Unauthorized');
        }

        const dbg_ = dbg.extend(params.name);

        dbg_(`Message body: ${JSON.stringify(body)}`);

        if (typeof body !== 'object')
            throw new BadRequestError('Invalid message format');

        await processMessage(params.name, body);
        res.status(200).end();
    }));

    api.get('*', jsonify(() => {
        throw new NotFoundError("Not Found");
    }));

    return api;
}
