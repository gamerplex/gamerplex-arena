self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.arena-server;
in
{
  options.services.arena-server = {
    enable = lib.mkEnableOption "Gamerplex Arena Server" // { default = true; };
    port = lib.mkOption { type = lib.types.port; default = 2567; };
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.arena = { isSystemUser = true; group = "arena"; };
    users.groups.arena = { };

    systemd.services.arena-server = {
      description = "Gamerplex Arena Server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        HOST = "0.0.0.0";
        PORT = toString cfg.port;
        MAX_ARENAS = "200";
        ARENA_SETTLEMENT = "none";
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = "-/xnode-config/env";
        User = "arena";
        Group = "arena";
        Restart = "on-failure";
        RestartSec = 10;
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
        ProtectProc = "invisible";
        ProcSubset = "pid";
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" "~@privileged" ];
        MemoryMax = "384M";
      };
    };

    networking.firewall.allowedTCPPorts = [ cfg.port ];
  };
}
