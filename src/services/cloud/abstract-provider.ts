export type CloudProviderType = "webdav" | "s3";

export interface CloudConfigData {
  config: Record<string, string>;
  id: number;
  isDefault: boolean;
  name: string;
  provider: CloudProviderType;
}

export interface CloudProvider {
  checkConnection(
    config: Record<string, string>
  ): Promise<{ success: boolean; latencyMs?: number; error?: string }>;

  listFiles(prefix: string, config: Record<string, string>): Promise<string[]>;
  readonly provider: CloudProviderType;

  upload(
    buffer: Buffer,
    remotePath: string,
    contentType: string,
    config: Record<string, string>
  ): Promise<string>;
}
