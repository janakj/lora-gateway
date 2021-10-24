import type { Request, Response, NextFunction } from 'express';

export function abort(error: any, signame = 'SIGTERM') {
    if (error !== undefined)
        console.error('Aborting: ', error);
    process.kill(process.pid, signame);
}


export function parseNumber(val: any, min?: number | string, max?: number | string) {
    if (typeof val === 'string') val = parseInt(val, 10);
    if (Number.isNaN(val))
        throw new Error(`Cannot convert '${val}' to integer`);

    if (typeof val !== 'number')
        throw new Error(`Unsupported number value type ${typeof val}`);

    if (min !== undefined) {
        if (typeof min === 'string') min = parseInt(min, 10);
        if (Number.isNaN(min))
            throw new Error(`Invalid minimum value '${min}'`);

        if (val < min)
            throw new Error(`Value ${val} must be >= than ${min}`);
    }

    if (max !== undefined) {
        if (typeof max === 'string') max = parseInt(max, 10);
        if (Number.isNaN(max))
            throw new Error(`Invalid maximum value '${max}'`);

        if (val > max)
            throw new Error(`Value ${val} must be <= than ${max}`);
    }

    return val;
}


export class HttpError extends Error {
    http_code: number | undefined;
    http_reason: string | undefined;
    constructor(message?: string, code?: number, reason?: string) {
        super(message);
        this.http_code = code;
        this.http_reason = reason;
    }
}

export class ServerError extends HttpError {
    constructor(message?: string, reason = 'Server Error', code = 500) {
        super(message, code, reason);
    }
}

export class BadRequestError extends HttpError {
    constructor(message?: string, reason = 'Bad Request', code = 400) {
        super(message, code, reason);
    }
}

export class UnauthorizedError extends HttpError {
    constructor(message?: string, reason = 'Unauthorized', code = 401) {
        super(message, code, reason);
    }
}

export class NotFoundError extends HttpError {
    constructor(message?: string, reason = 'Not Found', code = 404) {
        super(message, code, reason);
    }
}

export class ConflictError extends HttpError {
    constructor(message?: string, reason = 'Conflict', code = 409) {
        super(message, code, reason);
    }
}


export function jsonifyError(res: Response, error: Error) {
    const code = (error as HttpError).http_code || 500,
        reason = (error as HttpError).http_reason || 'Internal Server Error';
    res.statusMessage = reason;
    res.status(code);
    res.type('application/json')
    res.json({
        code,
        reason,
        message: error.message,
        ...(devMode && { stack: error.stack })
    });
}


export function jsonify(fn: (req: Request, res: Response, next: NextFunction) => any | Promise<any>) {
    return (req: Request, res: Response, next: NextFunction) => {
        void (async function () {
            try {
                const rv = await fn(req, res, next);
                if (rv !== undefined) res.json(rv);
            } catch(error: any) {
                try {
                    jsonifyError(res, error);
                } catch(e) {
                    // If we get an error here, it's most likely because jsonifyError
                    // attempted to set headers after they have been sent by express. Not
                    // much we can do about it other than notify the admin on the console.
                    console.log(e);
                }
            }
        })();
    };
}


export function sleep<T=any>(ms: number, value?: T) {
    return new Promise<T | undefined>(resolve => {
        setTimeout(() => {
            resolve(value);
        }, ms)
    });
}
