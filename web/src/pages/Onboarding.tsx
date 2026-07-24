import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useTour } from "../lib/tour";

/**
 * `/welcome` — thin launcher for the guided, in-context product tour (see lib/tour.tsx +
 * components/TourOverlay.tsx). The old static slideshow lived here; it's now the tour's first
 * (centered) step, so this route's only job is to start the tour and hand off to `/niches`,
 * where the spotlight takes over. Reached via a brand-new session's first-run redirect
 * (App.tsx), the sidebar's "Getting Started" link, or Settings' "Replay onboarding tour".
 */
export default function Onboarding() {
  const { startTour } = useTour();
  const navigate = useNavigate();

  useEffect(() => {
    startTour();
    navigate("/niches", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
