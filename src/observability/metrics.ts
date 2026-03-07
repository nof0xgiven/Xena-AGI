type CounterSample = {
  name: string;
  tags: Record<string, string>;
  value: number;
};

type TimingSample = {
  name: string;
  tags: Record<string, string>;
  value: number;
};

export function createMetrics() {
  const counters: CounterSample[] = [];
  const timings: TimingSample[] = [];

  return {
    counters(): CounterSample[] {
      return [...counters];
    },
    increment(
      name: string,
      value = 1,
      tags: Record<string, string> = {}
    ): void {
      counters.push({
        name,
        tags,
        value
      });
    },
    recordTiming(
      name: string,
      value: number,
      tags: Record<string, string> = {}
    ): void {
      timings.push({
        name,
        tags,
        value
      });
    },
    timings(): TimingSample[] {
      return [...timings];
    }
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
