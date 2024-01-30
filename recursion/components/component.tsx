import { useState, useEffect } from 'react';

import { toast } from 'react-toastify';
import React from 'react';
import { Noir, ProofData } from '@noir-lang/noir_js';
import { BarretenbergBackend } from '@noir-lang/backend_barretenberg';
import { BackendInstances, Circuits, Noirs, ProofArtifacts } from '../types';
import { useAccount, useConnect, useContractWrite, useWaitForTransaction } from 'wagmi';
import { InjectedConnector } from 'wagmi/connectors/injected';
import abi from '../utils/verifierAbi.json';
import axios from 'axios';

import { initializeResolver } from '@noir-lang/source-resolver';
import newCompiler, { compile, createFileManager } from '@noir-lang/noir_wasm';
import Ethers from '../utils/ethers';
import { join } from 'path';

function splitProof(aggregatedProof: Uint8Array) {
  const splitIndex = aggregatedProof.length - 2144;

  const publicInputsConcatenated = aggregatedProof.slice(0, splitIndex);

  const publicInputSize = 32;
  const publicInputs: Uint8Array[] = [];

  for (let i = 0; i < publicInputsConcatenated.length; i += publicInputSize) {
    const publicInput = publicInputsConcatenated.slice(i, i + publicInputSize);
    publicInputs.push(publicInput);
  }

  const proof = aggregatedProof.slice(splitIndex);
  return { proof, publicInputs };
}

export async function getFile(file_path: string): Promise<ReadableStream<Uint8Array>> {
  const file_url = new URL(file_path, import.meta.url);
  const response = await fetch(file_url);

  if (!response.ok) throw new Error('Network response was not OK');

  return response.body as ReadableStream<Uint8Array>;
}

// const { data: noirSource } = await axios.get('/api/readCircuitFile?filename=' + name);

// // eslint-disable-next-line @typescript-eslint/no-unused-vars
// initializeResolver((id: string) => {
//   const source = noirSource;
//   return source;
// });

async function getCircuit(name: string) {
  const fm = createFileManager('/');
  const nr = (await fetch(`/api/readCircuitFile?filename=${name}/src/main.nr`))
    .body as ReadableStream<Uint8Array>;
  await fm.writeFile('./src/main.nr', nr);

  const nargoToml = (await fetch(`/api/readCircuitFile?filename=${name}/Nargo.toml`))
    .body as ReadableStream<Uint8Array>;
  await fm.writeFile('./Nargo.toml', nargoToml);

  const result = await compile(fm);
  if (!('program' in result)) {
    throw new Error('Compilation failed');
  }

  return result.program;
}

function Component() {
  const [circuits, setCircuits] = useState<Circuits>();
  const [backends, setBackends] = useState<BackendInstances>();
  const [noirs, setNoirs] = useState<Noirs>();

  const [input, setInput] = useState<{ [key: string]: string }>({ x: '1', y: '2' });

  const { address, connector, isConnected } = useAccount();
  const { connect, connectors } = useConnect({
    connector: new InjectedConnector(),
  });

  const contractCallConfig = {
    address: '0x0165878A594ca255338adfa4d48449f69242Eb8F' as `0x${string}`,
    abi,
  };

  const { write, data, error, isLoading, isError } = useContractWrite({
    ...contractCallConfig,
    functionName: 'verify',
  });

  const {
    data: receipt,
    isLoading: isPending,
    isSuccess,
  } = useWaitForTransaction({ hash: data?.hash });

  // Handles input state
  const handleChange = e => {
    e.preventDefault();
    setInput({ ...input, [e.target.name]: e.target.value });
  };

  const calculateMainProof = async () => {
    const inputs = {
      x: '2',
      y: '3',
    };

    const proofGeneration: Promise<ProofArtifacts> = new Promise(async (resolve, reject) => {
      const { witness, returnValue } = await noirs!.main.execute(inputs);
      const { publicInputs, proof } = await backends!.main.generateIntermediateProof(witness);

      // Verify the same proof, not inside of a circuit
      const verified = await backends!.main.verifyIntermediateProof({ proof, publicInputs });

      // Now we will take that inner proof and verify it in an outer proof.
      const { proofAsFields, vkAsFields, vkHash } =
        await backends!.main.generateIntermediateProofArtifacts(
          { publicInputs, proof },
          1, // 1 public input
        );

      resolve({
        returnValue,
        proof,
        publicInputs,
        proofAsFields,
        vkAsFields,
        vkHash,
      });
    });

    toast.promise(proofGeneration, {
      pending: 'Generating proof',
      success: 'Proof generated',
      error: 'Error generating proof',
    });

    const mainProofArtifacts = await proofGeneration;

    const proofGeneration2: Promise<ProofData> = new Promise(async (resolve, reject) => {
      const aggregationObject: string[] = Array(16).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
      const recInput = {
        verification_key: mainProofArtifacts!.vkAsFields.map(e => e.toString()),
        proof: mainProofArtifacts!.proofAsFields,
        public_inputs: ['0x' + inputs['y']],
        key_hash: mainProofArtifacts!.vkHash,
        input_aggregation_object: aggregationObject,
      };

      const { witness } = await noirs!.recursive.execute(recInput);
      const proofData = await backends!.recursive.generateFinalProof(witness);

      resolve(proofData);
    });

    toast.promise(proofGeneration2, {
      pending: 'Generating recursive proof',
      success: 'Recursive proof generated',
      error: 'Error generating recursive proof',
    });

    const recursiveProofArtifacts = await proofGeneration2;

    const proofVerification = new Promise(async (resolve, reject) => {
      const { proof, publicInputs } = recursiveProofArtifacts;

      const verification = await backends!.recursive.verifyFinalProof({ proof, publicInputs });

      await noirs!.recursive.destroy();

      // const ethers = new Ethers();

      // const onChainVer = await ethers.contract.verify(proof, publicInputs);

      resolve(verification);
    });

    toast.promise(proofVerification, {
      pending: 'Verifying recursive proof',
      success: 'Recursive proof verified',
      error: 'Error verifying recursive proof',
    });
  };

  const init = async () => {
    const circuits = {
      main: await getCircuit('main'),
      recursive: await getCircuit('recursion'),
    };
    setCircuits(circuits);

    const backends = {
      main: new BarretenbergBackend(circuits.main, { threads: 8 }),
      recursive: new BarretenbergBackend(circuits.recursive, { threads: 8 }),
    };

    setBackends(backends);

    const noirs = {
      main: new Noir(circuits.main, backends.main),
      recursive: new Noir(circuits.recursive, backends.recursive),
    };
    await noirs.main.init();
    await noirs.recursive.init();

    setNoirs(noirs);
  };

  useEffect(() => {
    if (!backends || !circuits || !noirs) {
      init();
    }
  }, []);

  return (
    <div className="gameContainer">
      <h1>Recursive!</h1>
      <p>This circuit proves that x and y are different (main proof)</p>
      <p>
        Then it feeds that proof into another circuit, which then proves it verifies (recursive
        proof)
      </p>
      <h2>Try it!</h2>
      <input name="x" type={'text'} onChange={handleChange} value={input?.x} />
      <input name="y" type={'text'} onChange={handleChange} value={input?.y} />
      {circuits && backends && noirs && (
        <button onClick={calculateMainProof}>Calculate proof</button>
      )}
    </div>
  );
}

export default Component;
