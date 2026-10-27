{ lib, buildNpmPackage, nodejs_22, makeWrapper }:

buildNpmPackage {
  pname = "arena-server";
  version = "0.1.0";
  src = lib.cleanSource ../server;
  nodejs = nodejs_22;
  npmDepsHash = "sha256-7EnPPuBGabdpaFabUpof6h//ubMRgENHzS0WZpRC29A=";
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --no-audit --no-fund
    mkdir -p $out/lib/arena-server
    cp -r server.mjs arena.mjs settlement.mjs arenas node_modules package.json $out/lib/arena-server/
    makeWrapper ${nodejs_22}/bin/node $out/bin/arena-server --add-flags $out/lib/arena-server/server.mjs
    runHook postInstall
  '';

  meta.mainProgram = "arena-server";
}
