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
          nodejs = pkgs.nodejs_22;
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "takt";
            version = packageJson.version;
            src = ./.;

            npmDepsHash = "sha256-NI4xnLSqxE+CNOc4dJiI84Ayb5ie6atZrL5e+SnlQS4=";
            nodejs = nodejs;

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
          nodejs = pkgs.nodejs_22;
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
