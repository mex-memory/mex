{
  description = "mex - CLI engine for scaffold drift detection, pre-analysis, and targeted sync";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "mex";
            version = "0.3.2";

            src = ./.;

            npmDepsHash = "sha256-5gqoL5TeF7giN/qM7VfqY33rutlkmnIbq6FYPBTF3QE=";

            npmBuildScript = "build";

            # Ensure templates directory is included
            postInstall = ''
              mkdir -p $out/lib/node_modules/promexeus/templates
              cp -r templates/* $out/lib/node_modules/promexeus/templates/
            '';

            meta = with pkgs.lib; {
              description = "CLI engine for mex scaffold — drift detection, pre-analysis, and targeted sync";
              homepage = "https://github.com/PJalv/mex";
              license = licenses.mit;
              mainProgram = "mex";
              platforms = supportedSystems;
            };
          };
        });

      overlays.default = final: prev: {
        mex = self.packages.${final.system}.default;
      };

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.mex;
        in
        {
          options.programs.mex = {
            enable = lib.mkEnableOption "mex - scaffold drift detection CLI";
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ self.packages.${pkgs.system}.default ];
          };
        };

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_22
              npm
            ];
          };
        });
    };
}
