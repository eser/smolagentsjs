import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Tensor } from '@tensorflow/tfjs-node';

export class AgentType {
  constructor(value) {
    this._value = value;
  }

  toRaw() {
    console.warn('This is a raw AgentType of unknown type. Display and string conversion will be unreliable');
    return this._value;
  }

  toString() {
    console.warn('This is a raw AgentType of unknown type. Display and string conversion will be unreliable');
    return String(this._value);
  }
}

export class AgentText extends AgentType {
  toRaw() {
    return this._value;
  }

  toString() {
    return String(this._value);
  }
}

export class AgentImage extends AgentType {
  constructor(value) {
    super(value);
    this._path = null;
    this._raw = null;
    this._tensor = null;

    if (value instanceof AgentImage) {
      this._raw = value._raw;
      this._path = value._path;
      this._tensor = value._tensor;
    } else if (Buffer.isBuffer(value)) {
      this._raw = value;
    } else if (typeof value === 'string') {
      this._path = value;
    } else if (value instanceof Tensor) {
      this._tensor = value;
    } else {
      throw new TypeError(`Unsupported type for AgentImage: ${typeof value}`);
    }
  }

  async toRaw() {
    if (this._raw) {
      return this._raw;
    }

    if (this._path) {
      if (this._path.includes('://')) {
        const response = await fetch(this._path);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        this._raw = Buffer.from(arrayBuffer);
      } else {
        this._raw = await fs.promises.readFile(this._path);
      }
      return this._raw;
    }

    if (this._tensor) {
      // Convert tensor to image buffer using sharp
      const array = await this._tensor.array();
      const uint8Array = new Uint8Array((255 - array * 255).map(x => Math.round(x)));
      this._raw = await sharp(uint8Array, {
        raw: {
          width: array[0].length,
          height: array.length,
          channels: 1
        }
      }).png().toBuffer();
      return this._raw;
    }
  }

  async toString() {
    if (this._path) {
      return this._path;
    }

    const raw = await this.toRaw();
    const tempDir = os.tmpdir();
    this._path = path.join(tempDir, `${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(this._path, raw);
    return this._path;
  }

  async save(outputPath, options = {}) {
    const raw = await this.toRaw();
    await sharp(raw).png(options).toFile(outputPath);
  }
}
// Type mappings
const AGENT_TYPE_MAPPING = {
  string: AgentText,
  image: AgentImage,
};

const INSTANCE_TYPE_MAPPING = new Map([
  ['string', AgentText],
  ['object', AgentImage], // For Buffer
]);

export function handleAgentInputTypes(args, kwargs = {}) {
  const processedArgs = args.map(arg => arg instanceof AgentType ? arg.toRaw() : arg);
  const processedKwargs = {};
  for (const [key, value] of Object.entries(kwargs)) {
    processedKwargs[key] = value instanceof AgentType ? value.toRaw() : value;
  }
  return [processedArgs, processedKwargs];
}

export function handleAgentOutputTypes(output, outputType = null) {
  if (outputType && outputType in AGENT_TYPE_MAPPING) {
    return new AGENT_TYPE_MAPPING[outputType](output);
  }

  for (const [type, TypeClass] of INSTANCE_TYPE_MAPPING.entries()) {
    if (
      (type === 'string' && typeof output === 'string') ||
      (type === 'object' && Buffer.isBuffer(output)) ||
      (type === 'tensor' && output instanceof Tensor)
    ) {
      return new TypeClass(output);
    }
  }
  return output;
}
