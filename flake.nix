{
  description = "Workflow control for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "takt";
            version = packageJson.version;
            src = ./.;

            npmDepsHash = "sha256-v5acGqY5l4q70MrwUmmcmONfwNHH+KDuKQJvuSllsx0=";
            npmDepsFetcherVersion = 2;
            nodejs = nodejs;
            ONNXRUNTIME_NODE_INSTALL = "skip";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

            # npm prune fails in its reify rollback for this dependency tree.
            # Recreate the production-only tree from the same lockfile/cache,
            # retaining dependency install scripts without changing CI checks.
            preInstall = ''
              npm ci --omit=dev --ignore-scripts
              patchShebangs node_modules
              npm rebuild --omit=dev
              patchShebangs node_modules
            '';
            dontNpmPrune = true;

            meta = {
              description = packageJson.description;
              homepage = packageJson.homepage;
              license = pkgs.lib.licenses.mit;
              mainProgram = "takt";
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pkgs.bun
            ];
          };
        }
      );
    };
}
