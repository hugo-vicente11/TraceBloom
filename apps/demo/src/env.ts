/** Demo CLI configuration, resolved from the environment with dev defaults. */

export interface DemoConfig {
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUser: string;
  clickhousePassword: string;
  /** Collector OTLP endpoint the hero trace is exported to. */
  collectorEndpoint: string;
  dashboardUrl: string;
}

export function loadDemoConfig(): DemoConfig {
  return {
    clickhouseUrl: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    clickhouseDatabase: process.env.CLICKHOUSE_DATABASE ?? 'tracebloom',
    clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD ?? '',
    collectorEndpoint: process.env.TRACEBLOOM_ENDPOINT || 'http://localhost:4318',
    dashboardUrl: process.env.TRACEBLOOM_DASHBOARD_URL || 'http://localhost:3000',
  };
}
