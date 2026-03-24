// Type declarations for modules without bundled .d.ts files

declare module "circomlibjs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PoseidonFn = ((inputs: Array<bigint | string | number>) => any) & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    F: any;
  };

  export function buildPoseidon(): Promise<PoseidonFn>;
  export function buildBabyjub(): Promise<unknown>;
  export function buildEddsa(): Promise<unknown>;

  export const poseidonContract: {
    createCode(nInputs: number): string;
    generateABI(nInputs: number): unknown[];
  };
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: Record<string, any>,
      wasmFile: string,
      zkeyFileName: string
    ): Promise<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proof: any;
      publicSignals: string[];
    }>;
    exportSolidityCallData(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proof: any,
      pub: string[]
    ): Promise<string>;
  };
}
