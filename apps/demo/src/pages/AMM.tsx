/**
 * AMM Page — thin wrapper around AMMPageBody.
 *
 * The same body component is rendered inside MarketDrawer when launched
 * from the markets listing, so this file should stay minimal: just the
 * route param guard and a single render.
 */
import { useParams, Navigate } from "react-router-dom";
import { AMMPageBody } from "../components/features/market/AMMPageBody";

export const AMM = () => {
  const { marketAddress } = useParams<{ marketAddress?: string }>();
  if (!marketAddress) {
    return <Navigate to="/explore" replace />;
  }
  return <AMMPageBody marketAddress={marketAddress} />;
};

export default AMM;
