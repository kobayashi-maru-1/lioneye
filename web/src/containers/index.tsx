import { ErrorFallback } from "../components/ErrorFallback";
import { Loading } from "../components/Loading";
import { useAutoProgress } from "../components/AutoProgress";
import { AppBar } from "../components/AppBar";
import { CampaignTip } from "../components/CampaignTip";
import { Footer } from "../components/Footer";
import { LiveCharacterSync } from "../components/LiveCharacter";
import { upgradeGemLinksAtom } from "../state/pob";
import { moveOldTicksAtom } from "../state/route-progress";
import { pageMode } from "../state/saved-state";
import { pipe } from "../utility";
import { useSetAtom } from "jotai";
import { withBlank } from "../utility/withBlank";
import { withScrollRestoration } from "../utility/withScrollRestoration";
import { Suspense, lazy, useEffect, type JSX } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Route, Routes } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const RoutesContainer = pipe(
  withBlank,
  withScrollRestoration,
)(lazy(() => import("./Routes")));
const BuildContainer = withBlank(lazy(() => import("./Build")));
const EditRouteContainer = withBlank(lazy(() => import("./EditRoute")));
const StratsContainer = withBlank(lazy(() => import("./Strats")));
const AtlasContainer = withBlank(lazy(() => import("./Atlas")));

export function App() {
  useAutoProgress();
  // Campaign ticks saved before 0.4.7, moved to their new keys once.
  const moveOldTicks = useSetAtom(moveOldTicksAtom);
  // Gem links saved before gems turned off in PoB were marked, read again once.
  const upgradeGemLinks = useSetAtom(upgradeGemLinksAtom);
  useEffect(() => {
    if (pageMode !== "migrate") {
      moveOldTicks();
      upgradeGemLinks();
    }
  }, []);

  return (
    <>
      <AppBar />
      <Footer />
      {/* The in-game bar's Campaign tooltip, kept current on every page. */}
      <Suspense fallback={null}>
        <CampaignTip />
      </Suspense>
      {/* Your live character from poe.ninja (Compare, Build health). */}
      {pageMode !== "migrate" && <LiveCharacterSync />}
      <Suspense fallback={<Loading />}>
        <ErrorBoundary FallbackComponent={ErrorFallback}>
          <Routes>
            <Route
              path="/"
              element={<Page title="Lioneye" component={<RoutesContainer />} />}
            />
            {/* Settings (was "Build"); /build kept for old links. */}
            {["/settings", "/build"].map((path) => (
              <Route
                key={path}
                path={path}
                element={
                  <Page
                    title="Lioneye - Settings"
                    component={
                      <div className="page-narrow">
                        <BuildContainer />
                      </div>
                    }
                  />
                }
              />
            ))}
            {/* The League page (cheat sheet, builds, trade), live from GitHub Pages. */}
            <Route
              path="/strats"
              element={
                <Page
                  title="Lioneye - League"
                  component={<StratsContainer />}
                />
              }
            />
            {/* The atlas tree planner (poeatlasplanner.com), live in a frame. */}
            <Route
              path="/atlas"
              element={
                <Page title="Lioneye - Atlas" component={<AtlasContainer />} />
              }
            />
            <Route
              path="/edit-route"
              element={
                <Page
                  title="Lioneye - Edit Route"
                  component={
                    <div className="page-narrow page-fill">
                      <EditRouteContainer />
                    </div>
                  }
                />
              }
            />
          </Routes>
        </ErrorBoundary>
      </Suspense>
      <ToastContainer
        position="bottom-right"
        autoClose={2000}
        closeOnClick={true}
        theme={"dark"}
        pauseOnFocusLoss={false}
        pauseOnHover={false}
        newestOnTop={true}
      />
    </>
  );
}

interface PageProps {
  title: string;
  component: JSX.Element;
}

function Page({ title, component }: PageProps) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return component;
}
