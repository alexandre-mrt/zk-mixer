// Type declarations for modules without bundled types

declare module "circomlibjs" {
  type PoseidonFn = {
    (inputs: (bigint | number | string)[]): Uint8Array;
    F: {
      toObject: (a: Uint8Array) => bigint;
      e: (a: bigint | number | string) => Uint8Array;
      zero: Uint8Array;
      one: Uint8Array;
    };
  };

  export function buildPoseidon(): Promise<PoseidonFn>;
  export function buildPoseidonOpt(): Promise<PoseidonFn>;

  export const poseidonContract: {
    createCode: (nInputs: number) => string;
    generateABI: (nInputs: number) => unknown[];
  };
}

declare module "snarkjs" {
  type Proof = {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };

  type FullProveResult = {
    proof: Proof;
    publicSignals: string[];
  };

  export const groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasmFile: string | Uint8Array,
      zkeyFileName: string | Uint8Array,
      logger?: unknown,
    ) => Promise<FullProveResult>;

    verify: (
      vkVerifier: unknown,
      publicSignals: string[],
      proof: Proof,
      logger?: unknown,
    ) => Promise<boolean>;

    exportSolidityCallData: (
      proof: Proof,
      pub: string[],
    ) => Promise<string>;
  };
}
