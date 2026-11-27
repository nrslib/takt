export interface ResolvedDeepSeekHarnessPlugin {
  id?: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface DeepSeekHarnessPluginResolution {
  plugins: ResolvedDeepSeekHarnessPlugin[];
  cleanupPaths: string[];
  dispose(): Promise<void>;
}
