// GET /api/v1/config — frontend/integrator runtime config.
//
// Returns network + display-link bases the frontend would otherwise have
// to hardcode. Keeping this server-side lets ops flip preprod ↔ mainnet
// without a frontend redeploy, and gives third-party integrators a
// single place to read the canonical explorer / IPFS gateway URLs for
// this deployment.
//
// All fields are public — no auth required.
import express from "express";

const router = express.Router();

const DEFAULTS = {
  ipfsGatewayBase: "https://ipfs.io/ipfs/",
  explorerTxBase: "https://cexplorer.io/tx/",
  explorerAddressBase: "https://cexplorer.io/address/",
  network: "preprod",
};

router.get("/", (req, res) => {
  res.json({
    ipfsGatewayBase: process.env.IPFS_GATEWAY_BASE || DEFAULTS.ipfsGatewayBase,
    explorerTxBase: process.env.EXPLORER_TX_BASE || DEFAULTS.explorerTxBase,
    explorerAddressBase:
      process.env.EXPLORER_ADDRESS_BASE || DEFAULTS.explorerAddressBase,
    network: process.env.CARDANO_NETWORK || DEFAULTS.network,
  });
});

export default router;
