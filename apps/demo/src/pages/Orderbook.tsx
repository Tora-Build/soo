/**
 * Orderbook Page — thin wrapper around OrderbookPageBody.
 *
 * The same body component is rendered inside MarketDrawer when launched
 * from the markets listing.
 */
import { useParams, Navigate } from "react-router-dom";
import { OrderbookPageBody } from "../components/features/market/OrderbookPageBody";

export const Orderbook = () => {
  const { marketAddress } = useParams<{ marketAddress?: string }>();
  if (!marketAddress) {
    return <Navigate to="/explore" replace />;
  }
  return <OrderbookPageBody marketAddress={marketAddress} />;
};

export default Orderbook;
