import path from "node:path"

// The repository's files among the bundler's inputs (metafile.inputs' keys, relative to the folder the build ran in),
// as repository-relative paths, sorted: no installed package (anything under node_modules), nothing outside the
// repository, and no plugin's virtual module ("namespace:name", which is no file).
export function repositoryInputs(keys: string[], cwd: string, root: string) {
  const files = keys
    .filter((key) => !/^[\w-]+:(?![\\/])/.test(key))
    .map((key) => path.relative(root, path.resolve(cwd, key)).split(path.sep).join("/"))
    .filter((file) => file !== "" && !file.startsWith("../") && !path.isAbsolute(file))
    .filter((file) => !file.split("/").includes("node_modules"))
  return [...new Set(files)].toSorted()
}
