/**
 * @fileoverview Type definitions for smolagentsjs
 * @license Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { Tensor } from '@tensorflow/tfjs-node';
import wavefile from 'wavefile';

const WaveFile = wavefile.WaveFile;

/**
 * Abstract class for agent output types
 */
class AgentType {
  /**
   * @param {*} value - The value to wrap
   */
  constructor(value) {
    this._value = value;
  }

  /**
   * Get the raw value
   * @returns {*} Raw value
   */
  toRaw() {
    console.warn('This is a raw AgentType of unknown type. Display and string conversion will be unreliable');
    return this._value;
  }

  /**
   * Convert to string representation
   * @returns {string} String representation
   */
  toString() {
    console.warn('This is a raw AgentType of unknown type. Display and string conversion will be unreliable');
    return String(this._value);
  }
}

/**
 * Text type returned by the agent
 */
class AgentText extends AgentType {
  toRaw() {
    return this._value;
  }

  toString() {
    return String(this._value);
  }
}

/**
 * Image type returned by the agent
 */
class AgentImage extends AgentType {
  /**
   * @param {Buffer|string|Tensor} value - Image data
   */
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

  /**
   * Get raw image data
   * @returns {Promise<Buffer>} Raw image data
   */
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

  /**
   * Convert to string (file path)
   * @returns {Promise<string>} File path
   */
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

  /**
   * Save image to file
   * @param {string} outputPath - Output path
   * @param {Object} options - Sharp options
   */
  async save(outputPath, options = {}) {
    const raw = await this.toRaw();
    await sharp(raw).png(options).toFile(outputPath);
  }
}

/**
 * Audio type returned by the agent
 */
class AgentAudio extends AgentType {
  /**
   * @param {Buffer|string|Tensor} value - Audio data
   * @param {number} samplerate - Sample rate
   */
  constructor(value, samplerate = 16000) {
    super(value);
    this._path = null;
    this._tensor = null;
    this.samplerate = samplerate;

    if (typeof value === 'string') {
      this._path = value;
    } else if (value instanceof Tensor) {
      this._tensor = value;
    } else if (Array.isArray(value) && value.length === 2) {
      this.samplerate = value[0];
      this._tensor = value[1] instanceof Tensor ? value[1] : Tensor.make(value[1]);
    } else {
      throw new TypeError(`Unsupported type for AgentAudio: ${typeof value}`);
    }
  }

  /**
   * Get raw audio data
   * @returns {Promise<Tensor>} Audio tensor
   */
  async toRaw() {
    if (this._tensor) {
      return this._tensor;
    }

    if (this._path) {
      if (this._path.includes('://')) {
        const response = await fetch(this._path);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const wav = new WaveFile(Buffer.from(arrayBuffer));
        this._tensor = Tensor.make(wav.getSamples());
        this.samplerate = wav.fmt.sampleRate;
      } else {
        const wav = new WaveFile(await fs.promises.readFile(this._path));
        this._tensor = Tensor.make(wav.getSamples());
        this.samplerate = wav.fmt.sampleRate;
      }
      return this._tensor;
    }
  }

  /**
   * Convert to string (file path)
   * @returns {Promise<string>} File path
   */
  async toString() {
    if (this._path) {
      return this._path;
    }

    const tensor = await this.toRaw();
    const tempDir = os.tmpdir();
    this._path = path.join(tempDir, `${crypto.randomUUID()}.wav`);
    
    const wav = new WaveFile();
    wav.fromScratch(1, this.samplerate, '32f', tensor.arraySync());
    await fs.promises.writeFile(this._path, wav.toBuffer());
    
    return this._path;
  }
}

// Type mappings
const AGENT_TYPE_MAPPING = {
  string: AgentText,
  image: AgentImage,
  audio: AgentAudio
};

const INSTANCE_TYPE_MAPPING = new Map([
  ['string', AgentText],
  ['object', AgentImage], // For Buffer
  ['tensor', AgentAudio]
]);

/**
 * Handle agent input types
 * @param {Array} args - Positional arguments
 * @param {Object} kwargs - Keyword arguments
 * @returns {Array} Processed arguments
 */
function handleAgentInputTypes(args, kwargs = {}) {
  const processedArgs = args.map(arg => arg instanceof AgentType ? arg.toRaw() : arg);
  const processedKwargs = {};
  for (const [key, value] of Object.entries(kwargs)) {
    processedKwargs[key] = value instanceof AgentType ? value.toRaw() : value;
  }
  return [processedArgs, processedKwargs];
}

/**
 * Handle agent output types
 * @param {*} output - Output to process
 * @param {string} outputType - Expected output type
 * @returns {AgentType} Processed output
 */
function handleAgentOutputTypes(output, outputType = null) {
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

export {
  AgentType,
  AgentImage,
  AgentText,
  AgentAudio,
  handleAgentInputTypes,
  handleAgentOutputTypes
}; 
