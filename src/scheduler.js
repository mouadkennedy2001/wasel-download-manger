// Starts and stops the queue at the times set in Settings → Schedule. Each boundary fires
// once per day even though the clock is polled more often.
class Scheduler {
  constructor({ manager, now = () => new Date(), interval = 15_000 }) {
    this.manager = manager;
    this.now = now;
    this.interval = interval;
    this.fired = { start: '', stop: '' };
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.interval);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const { schedule } = this.manager.getState().settings;
    if (!schedule?.enabled) return null;
    const now = this.now();
    if (!schedule.days.includes(now.getDay())) return null;
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toDateString();
    if (clock === schedule.start && this.fired.start !== today) {
      this.fired.start = today;
      await this.manager.resumeAll();
      return 'start';
    }
    if (schedule.stop && clock === schedule.stop && this.fired.stop !== today) {
      this.fired.stop = today;
      await this.manager.pauseAll();
      return 'stop';
    }
    return null;
  }
}

function nextRun(schedule, from = new Date()) {
  if (!schedule?.enabled || !schedule.days?.length) return null;
  const [hours, minutes] = schedule.start.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate > from && schedule.days.includes(candidate.getDay())) return candidate;
  }
  return null;
}

module.exports = { Scheduler, nextRun };
