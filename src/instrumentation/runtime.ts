import { isNode } from '../core/runtime';

// ---------------------------------------------------------------------------
// Runtime Metrics Collector
//
// Collects Node.js runtime health metrics at configurable intervals:
//   - Event loop lag (delay)
//   - Event loop utilization (ELU) — Node.js 14.10+
//   - Garbage collection duration and frequency
//   - Heap memory usage and allocation
//   - Active handles and requests count
//   - CPU usage (user + system)
//
// These metrics are sent as a separate payload type to the APM ingest
// endpoint, enabling runtime health dashboards.
//
// Follows OTel Runtime Metrics semantic conventions where applicable.
// ---------------------------------------------------------------------------

export interface RuntimeMetricsPayload {
  timestamp: string;
  metrics: RuntimeMetrics;
}

export interface RuntimeMetrics {
  // Event Loop
  eventLoop: {
    lagMs: number;           // Current event loop lag in milliseconds
    lagP50Ms?: number;       // p50 lag (if histogram available)
    lagP99Ms?: number;       // p99 lag (if histogram available)
    utilizationPercent?: number; // Event loop utilization 0-100 (Node 14.10+)
  };

  // Garbage Collection
  gc: {
    totalDurationMs: number; // Total GC time since last report
    totalCount: number;      // Total GC pauses since last report
    majorCount: number;      // Major (mark-sweep) GC count
    minorCount: number;      // Minor (scavenge) GC count
    incrementalCount: number; // Incremental marking count
    weakCallbackCount: number; // Weak callback processing count
  };

  // Memory
  memory: {
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    rssBytes: number;
    heapUsedPercent: number; // heapUsed / heapTotal * 100
  };

  // Process
  process: {
    activeHandles: number;
    activeRequests: number;
    cpuUserUs: number;       // CPU user time delta since last report (microseconds)
    cpuSystemUs: number;     // CPU system time delta since last report (microseconds)
    uptimeSeconds: number;
  };
}

// ---------------------------------------------------------------------------
// GC Observer (uses perf_hooks PerformanceObserver)
// ---------------------------------------------------------------------------

interface GcStats {
  totalDurationMs: number;
  totalCount: number;
  majorCount: number;       // kind=2 (MarkSweepCompact)
  minorCount: number;       // kind=1 (Scavenge)
  incrementalCount: number; // kind=4 (IncrementalMarking)
  weakCallbackCount: number; // kind=8 (ProcessWeakCallbacks)
}

const GC_KINDS: Record<number, keyof Pick<GcStats, 'majorCount' | 'minorCount' | 'incrementalCount' | 'weakCallbackCount'>> = {
  1: 'minorCount',
  2: 'majorCount',
  4: 'incrementalCount',
  8: 'weakCallbackCount',
};

class GcObserver {
  private stats: GcStats = {
    totalDurationMs: 0,
    totalCount: 0,
    majorCount: 0,
    minorCount: 0,
    incrementalCount: 0,
    weakCallbackCount: 0,
  };
  private observer: any = null;

  start() {
    try {
      const { PerformanceObserver } = require('perf_hooks');

      this.observer = new PerformanceObserver((list: any) => {
        for (const entry of list.getEntries()) {
          this.stats.totalDurationMs += entry.duration;
          this.stats.totalCount++;

          const kindKey = GC_KINDS[entry.detail?.kind ?? entry.kind];
          if (kindKey) {
            this.stats[kindKey]++;
          }
        }
      });

      this.observer.observe({ type: 'gc', buffered: true });
    } catch {
      // perf_hooks or gc observation not available
    }
  }

  /** Take and reset collected GC stats since last call. */
  take(): GcStats {
    const snapshot = { ...this.stats };
    this.stats = {
      totalDurationMs: 0,
      totalCount: 0,
      majorCount: 0,
      minorCount: 0,
      incrementalCount: 0,
      weakCallbackCount: 0,
    };
    return snapshot;
  }

  stop() {
    try {
      this.observer?.disconnect();
    } catch { }
    this.observer = null;
  }
}

// ---------------------------------------------------------------------------
// Event Loop Lag Measurement
// ---------------------------------------------------------------------------

class EventLoopLagMeter {
  private lastCheck = 0;
  private lagMs = 0;
  private timer: any = null;
  private monitoringHistogram: any = null;

  start() {
    // High-resolution lag sampling via setImmediate
    this.lastCheck = performance.now();
    this.scheduleSample();

    // Try to use monitorEventLoopDelay for histogram (Node 12+)
    try {
      const { monitorEventLoopDelay } = require('perf_hooks');
      this.monitoringHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.monitoringHistogram.enable();
    } catch { }
  }

  private scheduleSample() {
    this.timer = setTimeout(() => {
      const now = performance.now();
      // Timer was scheduled for ~100ms; anything above that is lag
      const elapsed = now - this.lastCheck;
      this.lagMs = Math.max(0, elapsed - 100);
      this.lastCheck = now;
      this.scheduleSample();
    }, 100);

    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  take(): { lagMs: number; lagP50Ms?: number; lagP99Ms?: number } {
    const result: any = { lagMs: Math.round(this.lagMs * 100) / 100 };

    if (this.monitoringHistogram) {
      try {
        // percentile() returns nanoseconds
        result.lagP50Ms = Math.round(this.monitoringHistogram.percentile(50) / 1e6 * 100) / 100;
        result.lagP99Ms = Math.round(this.monitoringHistogram.percentile(99) / 1e6 * 100) / 100;
        this.monitoringHistogram.reset();
      } catch { }
    }

    return result;
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.monitoringHistogram?.disable();
    } catch { }
  }
}

// ---------------------------------------------------------------------------
// Event Loop Utilization (Node 14.10+)
// ---------------------------------------------------------------------------

class EventLoopUtilization {
  private elu1: any = null;
  private getELU: (() => any) | null = null;

  start() {
    try {
      const { performance: perfHooks } = require('perf_hooks');
      if (typeof perfHooks.eventLoopUtilization === 'function') {
        this.getELU = () => perfHooks.eventLoopUtilization();
        this.elu1 = this.getELU();
      }
    } catch { }
  }

  take(): number | undefined {
    if (!this.getELU || !this.elu1) return undefined;
    try {
      const elu2 = this.getELU();
      const { performance: perfHooks } = require('perf_hooks');
      const util = perfHooks.eventLoopUtilization(this.elu1, elu2);
      this.elu1 = elu2;
      return Math.round(util.utilization * 10000) / 100; // 0-100 with 2 decimal
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime Metrics Collector
// ---------------------------------------------------------------------------

export interface RuntimeMetricsOptions {
  /** Collection interval in milliseconds. Default: 15000 (15s). */
  interval?: number;
  /** Callback invoked with each metrics snapshot. */
  onMetrics: (payload: RuntimeMetricsPayload) => void;
}

export class RuntimeMetricsCollector {
  private gcObserver = new GcObserver();
  private lagMeter = new EventLoopLagMeter();
  private eluMeter = new EventLoopUtilization();
  private lastCpu: NodeJS.CpuUsage | undefined;
  private timer: any = null;
  private interval: number;
  private onMetrics: (payload: RuntimeMetricsPayload) => void;
  private started = false;

  constructor(options: RuntimeMetricsOptions) {
    this.interval = options.interval || 15000;
    this.onMetrics = options.onMetrics;
  }

  start() {
    if (!isNode() || this.started) return;
    this.started = true;

    this.gcObserver.start();
    this.lagMeter.start();
    this.eluMeter.start();

    try {
      this.lastCpu = process.cpuUsage();
    } catch { }

    this.timer = setInterval(() => {
      try {
        this.collect();
      } catch { }
    }, this.interval);

    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private collect() {
    const mem = process.memoryUsage();
    const gc = this.gcObserver.take();
    const lagInfo = this.lagMeter.take();
    const eluPercent = this.eluMeter.take();

    // CPU delta
    let cpuUserUs = 0;
    let cpuSystemUs = 0;
    try {
      if (this.lastCpu) {
        const delta = process.cpuUsage(this.lastCpu);
        cpuUserUs = delta.user;
        cpuSystemUs = delta.system;
      }
      this.lastCpu = process.cpuUsage();
    } catch { }

    // Active handles/requests
    let activeHandles = 0;
    let activeRequests = 0;
    try {
      activeHandles = (process as any)._getActiveHandles?.()?.length ?? 0;
      activeRequests = (process as any)._getActiveRequests?.()?.length ?? 0;
    } catch { }

    const metrics: RuntimeMetrics = {
      eventLoop: {
        lagMs: lagInfo.lagMs,
        lagP50Ms: lagInfo.lagP50Ms,
        lagP99Ms: lagInfo.lagP99Ms,
        utilizationPercent: eluPercent,
      },
      gc,
      memory: {
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers || 0,
        rssBytes: mem.rss,
        heapUsedPercent: mem.heapTotal > 0
          ? Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100
          : 0,
      },
      process: {
        activeHandles,
        activeRequests,
        cpuUserUs,
        cpuSystemUs,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };

    this.onMetrics({
      timestamp: new Date().toISOString(),
      metrics,
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.gcObserver.stop();
    this.lagMeter.stop();
    this.started = false;
  }
}
