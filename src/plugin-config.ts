export interface ArchonPluginConfig {
  /**
   * The systemd service this node runs (e.g. `archon-api`, `archon-worker`).
   * Optional: when omitted, the plugin auto-detects the single installed
   * `archon-*.service` on the host (see detect-service.ts). Set it explicitly
   * only on hosts that run more than one archon service (ambiguous → detection
   * throws).
   */
  service?: string;
  appRoot: string;
  user: string;
  healthProbePort: number;
}
