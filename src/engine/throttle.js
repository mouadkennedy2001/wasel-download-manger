// Global token bucket shared by every connection so the speed limit applies to the
// whole app, not to each download separately.
class Throttle {
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.capacity = Math.max(64 * 1024, this.rate / 4);
    this.tokens = this.capacity;
    this.updatedAt = Date.now();
  }

  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) * this.rate) / 1000);
    this.updatedAt = now;
  }

  async consume(bytes, shouldStop = () => false) {
    if (!this.rate) return;
    let remaining = bytes;
    while (remaining > 0) {
      if (shouldStop()) return;
      this.refill();
      const granted = Math.min(remaining, Math.floor(this.tokens));
      if (granted > 0) {
        this.tokens -= granted;
        remaining -= granted;
        continue;
      }
      const wait = Math.max(5, Math.ceil(((Math.min(remaining, this.capacity) - this.tokens) * 1000) / this.rate));
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 250)));
    }
  }
}

module.exports = { Throttle };
