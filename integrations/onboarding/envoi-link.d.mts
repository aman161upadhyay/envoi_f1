export interface HelperDependencies {
  adopt?: (activation: any, context: any) => Promise<unknown>;
  runtime?: { type: string; version: string | null };
  requestedPermissions?: string[];
  directory?: string; contract?: any;
  fetch?: typeof fetch; confirm?: any; now?: () => number; sleep?: (ms: number) => Promise<void>;
  [key: string]: any;
}
export function runCli(args: string[], dependencies?: HelperDependencies): Promise<Record<string, any>>;
export function createHelper(dependencies?: HelperDependencies): Promise<any>;
export function draftConnect(args: string[]): Record<string, any>;

export function connectionFailure(contract: any, error: unknown): Record<string, any> | null;
