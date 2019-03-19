// @flow

import AssetGraph from './AssetGraph';
import type {
  Bundle,
  BundleGraph,
  CLIOptions,
  ParcelConfig,
  ServerOptions
} from '@parcel/types';
import type {PrintableError} from '@parcel/logger/src/prettyError';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import TargetResolver from './TargetResolver';
import getRootDir from '@parcel/utils/getRootDir';
import loadEnv from './loadEnv';
import path from 'path';
import Cache from '@parcel/cache';
import AssetGraphBuilder from './AssetGraphBuilder';
import ConfigResolver from './ConfigResolver';
import {HMRServer, serve} from '@parcel/server';
import type {Server} from '@parcel/server';
import EventEmitter from 'events';

const abortError = new Error('Build aborted');

type ParcelOpts = {|
  entries: string | Array<string>,
  cwd?: string,
  cliOpts: CLIOptions,
  killWorkers?: boolean,
  env?: {[string]: ?string},
  config?: ParcelConfig,
  defaultConfig?: ParcelConfig,
  hot?: ServerOptions | boolean,
  serve?: ServerOptions | boolean
|};

export default class Parcel extends EventEmitter {
  options: ParcelOpts;
  entries: Array<string>;
  rootDir: string;
  assetGraphBuilder: AssetGraphBuilder;
  bundlerRunner: BundlerRunner;
  farm: WorkerFarm;
  runPackage: (bundle: Bundle) => Promise<mixed>;
  server: Server;
  pending: boolean;
  error: PrintableError;
  bundleGraph: BundleGraph;
  hmrServer: HMRServer;

  constructor(options: ParcelOpts) {
    super();

    let {entries} = options;

    this.options = options;
    this.entries = Array.isArray(entries) ? entries : [entries];
    this.rootDir = getRootDir(this.entries);
  }

  async init(): Promise<void> {
    await Cache.createCacheDir(this.options.cliOpts.cacheDir);

    if (!this.options.env) {
      await loadEnv(path.join(this.rootDir, 'index'));
      this.options.env = process.env;
    }

    let configResolver = new ConfigResolver();
    let config;

    // If an explicit `config` option is passed use that, otherwise resolve a .parcelrc from the filesystem.
    if (this.options.config) {
      config = await configResolver.create(this.options.config, this.rootDir);
    } else {
      config = await configResolver.resolve(this.rootDir);
    }

    // If no config was found, default to the `defaultConfig` option if one is provided.
    if (!config && this.options.defaultConfig) {
      config = await configResolver.create(
        this.options.defaultConfig,
        this.rootDir
      );
    }

    if (!config) {
      throw new Error('Could not find a .parcelrc');
    }

    this.bundlerRunner = new BundlerRunner({
      config,
      cliOpts: this.options.cliOpts,
      rootDir: this.rootDir
    });

    let targetResolver = new TargetResolver();
    let targets = await targetResolver.resolve(this.rootDir);

    this.assetGraphBuilder = new AssetGraphBuilder({
      cliOpts: this.options.cliOpts,
      config,
      entries: this.entries,
      targets,
      rootDir: this.rootDir
    });

    this.farm = await WorkerFarm.getShared(
      {
        config,
        cliOpts: this.options.cliOpts,
        env: this.options.env
      },
      {
        workerPath: require.resolve('./worker')
      }
    );

    this.runPackage = this.farm.mkhandle('runPackage');

    if (this.options.serve) {
      // Not sure if the server should even be mentioned in the core?
      // Perhaps it should be part of the cli?
      this.server = await serve(this, this.options.serve);
    }

    if (this.options.hot) {
      this.hmrServer = await serve(this, this.options.hot);

      this.assetGraphBuilder.on('transformed', cacheEntry => {
        this.hmrServer.addChangedAsset(cacheEntry);
      });
    }
  }

  async run(): Promise<BundleGraph> {
    await this.init();

    this.assetGraphBuilder.on('invalidate', () => {
      this.build();
    });

    return this.build();
  }

  async build(): Promise<BundleGraph> {
    try {
      // console.log('Starting build'); // eslint-disable-line no-console
      this.pending = true;

      let assetGraph = await this.assetGraphBuilder.build();

      if (process.env.PARCEL_DUMP_GRAPH != null) {
        const dumpGraphToGraphViz = require('@parcel/utils/src/dumpGraphToGraphViz')
          .default;
        await dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');
      }

      let bundleGraph = await this.bundle(assetGraph);
      await this.package(bundleGraph);

      if (!this.options.cliOpts.watch && this.options.killWorkers !== false) {
        await this.farm.end();
      }

      this.bundleGraph = bundleGraph;
      this.emit('bundled');
      // console.log('Finished build'); // eslint-disable-line no-console
      return bundleGraph;
    } catch (e) {
      if (e !== abortError) {
        console.error(e); // eslint-disable-line no-console
      }
      this.error = e;
      throw e;
    }
  }

  bundle(assetGraph: AssetGraph): Promise<BundleGraph> {
    return this.bundlerRunner.bundle(assetGraph);
  }

  package(bundleGraph: BundleGraph): Promise<mixed> {
    let promises = [];
    bundleGraph.traverseBundles(bundle => {
      promises.push(this.runPackage(bundle));
    });

    return Promise.all(promises);
  }
}

export {default as Asset} from './Asset';
export {default as Dependency} from './Dependency';
export {default as Environment} from './Environment';
