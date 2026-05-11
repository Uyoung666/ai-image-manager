export type CloudProviderType = "webdav" | "s3";

export interface CloudConfigData {
  id: number;
  name: string;
  provider: CloudProviderType;
  config: Record<string, string>;
  isDefault: boolean;
}

export interface CloudProvider {
  readonly provider: CloudProviderType;

  checkConnection(config: Record<string, string>): Promise<{ success: boolean; latencyMs?: number; error?: string }>;

  upload(
    buffer: Buffer,
    remotePath: string,
    contentType: string,
    config: Record<string, string>
  ): Promise<string>;

  listFiles(prefix: string, config: Record<string, string>): Promise<string[]>;
}
