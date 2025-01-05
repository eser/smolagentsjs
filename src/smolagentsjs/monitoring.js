/**
 * @fileoverview Monitoring implementation for smolagentsjs
 * @license Apache-2.0
 */

/**
 * Monitor class for tracking agent execution metrics
 */
export class Monitor {
  /**
   * @param {Object} trackedModel - The model to track
   */
  constructor(trackedModel) {
    this.stepDurations = [];
    this.trackedModel = trackedModel;
    
    // Check if the model supports token counting
    if (this.trackedModel?.lastInputTokenCount !== undefined) {
      this.totalInputTokenCount = 0;
      this.totalOutputTokenCount = 0;
    }
  }

  /**
   * Get total token counts
   * @returns {Object} Token counts
   */
  getTotalTokenCounts() {
    return {
      input: this.totalInputTokenCount,
      output: this.totalOutputTokenCount
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.stepDurations = [];
    this.totalInputTokenCount = 0;
    this.totalOutputTokenCount = 0;
  }

  /**
   * Update metrics with new step information
   * @param {Object} stepLog - Log information from the step
   */
  updateMetrics(stepLog) {
    const stepDuration = stepLog.duration;
    this.stepDurations.push(stepDuration);
    
    let consoleOutputs = `[Step ${this.stepDurations.length - 1}: Duration ${stepDuration.toFixed(2)} seconds`;

    if (this.trackedModel?.lastInputTokenCount !== undefined) {
      this.totalInputTokenCount += this.trackedModel.lastInputTokenCount;
      this.totalOutputTokenCount += this.trackedModel.lastOutputTokenCount;
      consoleOutputs += ` | Input tokens: ${this.totalInputTokenCount.toLocaleString()} | Output tokens: ${this.totalOutputTokenCount.toLocaleString()}`;
    }
    
    consoleOutputs += ']';
    console.log(consoleOutputs, null, { style: 'dim' });
  }
}
