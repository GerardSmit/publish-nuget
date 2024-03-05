const os = require('os');
const fs = require('fs');
const path = require('path');
const spawnSync = require('child_process').spawnSync;

const globalVersionFile = process.env.INPUT_VERSION_FILE || process.env.VERSION_FILE;
const staticVersion = process.env.INPUT_VERSION_STATIC || process.env.VERSION_STATIC;
const versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || process.env.VERSION_REGEX, 'm');
const tagCommit = JSON.parse(process.env.INPUT_TAG_COMMIT || process.env.TAG_COMMIT);
const tagFormat = process.env.INPUT_TAG_FORMAT || process.env.TAG_FORMAT;
const nugetKey = process.env.INPUT_NUGET_KEY || process.env.NUGET_KEY;
const nugetSource = process.env.INPUT_NUGET_SOURCE || process.env.NUGET_SOURCE;
const includeSymbols = JSON.parse(process.env.INPUT_INCLUDE_SYMBOLS || process.env.INCLUDE_SYMBOLS);
const noBuild = JSON.parse(process.env.INPUT_NO_BUILD || process.env.NO_BUILD);
/** @type {string[]} */ const output = [];

publishAll();

/**
 * Get the package name from the project file
 * @param {string} projectFile Project file path
 * @returns {string}
 **/
function getPackageName (projectFile) {
  // Try to find the package name from the project file
  if (fs.existsSync(projectFile)) {
    const projectFileContent = fs.readFileSync(projectFile, { encoding: 'utf-8' });
    const packageId = /^\s*<PackageId>(.*)<\/PackageId>\s*$/m.exec(projectFileContent);

    if (packageId) {
      return packageId[1];
    }

    const assemblyName = /^\s*<AssemblyName>(.*)<\/AssemblyName>\s*$/m.exec(projectFileContent);

    if (assemblyName) {
      return assemblyName[1];
    }
  }

  // Fallback to the project filename
  return path.basename(projectFile).split('.').slice(0, -1).join('.');
}

/**
 * Set output variable value for the GitHub Actions
 * @param {string} name Output variable name
 * @param {string} value Output variable value
 * @returns {void}
 **/
function setOutput (name, value) {
  output.push(`${name}=${value}`);
}

/**
 * Flush output variables to the file
 * @returns {void}
 **/
function flushOutput () {
  const filePath = process.env.GITHUB_OUTPUT;

  if (filePath) {
    fs.appendFileSync(filePath, output.join(os.EOL));
  }
}

/**
 * Execute command
 * @param {string} cmd Command to execute
 * @param {object} options Spawn options
 * @returns {import('child_process').SpawnSyncReturns<string>}
 **/
function executeCommand (cmd, options = {}) {
  console.log(`executing: [${cmd}]`);

  const input = cmd.split(' ');
  const processName = input[0];
  const args = input.slice(1);

  return spawnSync(processName, args, { encoding: 'utf-8', ...options });
}

/**
 * Execute command in process
 * @param {string} cmd Command to execute
 * @returns {void}
 **/
function executeInProcess (cmd) {
  executeCommand(cmd, { stdio: [process.stdin, process.stdout, process.stderr] });
}

/**
 * Tag the current commit
 * @param {string} version Version to tag
 */
function createTag (version) {
  const TAG = tagFormat.replace('*', version);

  console.log(`✨ Creating new tag ${TAG}`);

  executeInProcess(`git tag ${TAG}`);
  executeInProcess(`git push origin ${TAG}`);
  setOutput('VERSION', TAG);
}

/**
 * Push the package to the NuGet source
 * @param {string} projectFile Project file path
 * @param {string} version Version to push
 * @param {string} name Package name
 * @returns {void}
 **/
function pushPackage (projectFile, version, name) {
  console.log(`✨ Found new version (${version}) of ${name}`);
  console.log(`NuGet Source: ${nugetSource}`);

  fs.readdirSync('.').filter(fn => /\.s?nupkg$/.test(fn)).forEach(fn => fs.unlinkSync(fn));

  if (!noBuild) {
    executeInProcess(`dotnet build -c Release ${projectFile}`);
  }

  executeInProcess(`dotnet pack ${includeSymbols ? '--include-symbols -p:SymbolPackageFormat=snupkg' : ''} -c Release ${projectFile} -o .`);

  const packages = fs.readdirSync('.').filter(fn => fn.endsWith('nupkg'));
  console.log(`Generated Package(s): ${packages.join(', ')}`);

  const pushCmd = `dotnet nuget push *.nupkg -s ${nugetSource}/v3/index.json -k ${nugetKey} --skip-duplicate${!includeSymbols ? ' -n' : ''}`;
  const pushOutput = executeCommand(pushCmd).stdout;

  console.log(pushOutput);

  if (/error/.test(pushOutput)) {
    throw new Error(`${/error.*/.exec(pushOutput)?.[0]}`);
  }
}

/**
 * Check if the current version is pushed to the NuGet source.
 * @param {string} packageName Name of the package
 * @param {string} version Version to check
 * @returns {Promise<boolean>}
 */
async function isNewPackageVersion (packageName, version) {
  console.log(`Package Name: ${packageName}`);

  const url = `${nugetSource}/v3-flatcontainer/${packageName.toLowerCase()}/index.json`;
  console.log(`Getting versions from ${url}`);

  const response = await fetch(url);

  if (response.status === 404) {
    console.log('404 response, assuming new package');
    return true;
  }

  if (!response.ok) {
    throw new Error(`Failed to get versions from NuGet: ${response.statusText}`);
  }

  /**
   * @type {{versions: string[]}}
   */
  let existingVersions;

  try {
    // @ts-ignore
    existingVersions = await response.json();
  } catch (e) {
    throw new Error(`Failed to parse response from NuGet: ${e}`);
  }

  console.log(`Versions retrieved: ${existingVersions.versions}`);

  return !existingVersions.versions.includes(version);
}

/**
 * Publish the project
 * @param {string} projectFile Project file path
 * @returns {Promise<string>}
 */
async function publish (projectFile) {
  if (!projectFile || !fs.existsSync(projectFile)) {
    throw new Error('Project file not found');
  }

  console.log(`Project Filepath: ${projectFile}`);

  const packageName = getPackageName(projectFile);
  const versionFile = globalVersionFile || projectFile;

  if (!fs.existsSync(versionFile)) {
    throw new Error('Version file not found');
  }

  console.log(`Version Filepath: ${versionFile}`);

  let version;

  if (staticVersion) {
    version = staticVersion;
  } else {
    console.log(`Version Regex: ${versionRegex}`);

    const versionFileContent = fs.readFileSync(versionFile, { encoding: 'utf-8' });
    version = versionRegex.exec(versionFileContent)?.[1];
  }

  if (!version) {
    throw new Error('Version not found');
  }

  console.log(`Version: ${version}`);

  if (!await isNewPackageVersion(packageName, version)) {
    return version;
  }

  pushPackage(projectFile, version, packageName);
  return version;
}

/**
 * Publish all the packages
 */
async function publishAll () {
  /** @type {string[]} */ const versions = [];

  const files = process.env.INPUT_PROJECT_FILE_PATH
    .split(/\r\n|\n|\r/)
    .map(f => f.trim())
    .filter(f => f.length > 0);

  for (const file of files) {
    console.log(`📦 Processing ${file}`);

    try {
      const version = await publish(file);

      if (!versions.includes(version)) {
        versions.push(version);
      }
    } catch (e) {
      console.log(`##[error]😭 ${e}`);
    }

    console.log('');
  }

  // Tag the current commit
  if (versions.length > 1) {
    console.log(`##[error]😭 Multiple versions detected (${versions.join(', ')}), unable to tag`);
  } else if (tagCommit && versions.length === 1) {
    try {
      createTag(versions[0]);
    } catch (e) {
      console.log(`##[error]😭 Unable to create a new tag ${e}`);
    }
  }

  flushOutput();
}
