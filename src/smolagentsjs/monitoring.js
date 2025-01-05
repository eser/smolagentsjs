export class Monitor {
  constructor(trackedModel) {
    this.stepDurations = [];
    this.trackedModel = trackedModel;
    
    // Check if the model supports token counting
    if (this.trackedModel?.lastInputTokenCount !== undefined) {
      this.totalInputTokenCount = 0;
      this.totalOutputTokenCount = 0;
    }
  }

  getTotalTokenCounts() {
    return {
      input: this.totalInputTokenCount,
      output: this.totalOutputTokenCount
    };
  }

  reset() {
    this.stepDurations = [];
    this.totalInputTokenCount = 0;
    this.totalOutputTokenCount = 0;
  }

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
