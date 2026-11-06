import { ErrorFallback } from "../components/ErrorFallback";
import { Loading } from "../components/Loading";
import { useAutoProgress } from "../components/AutoProgress";
import { AppBar } from "../components/AppBar";
import { CampaignTip } from "../components/CampaignTip";
import { Footer } from "../components/Footer";
import { STATS_AVAILABLE } from "../components/PobStats";
import { pipe } from "../utility";
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

export function App() {
  useAutoProgress();

  return (
    <>
      <AppBar />
      {STATS_AVAILABLE && <Footer />}
      {/* The in-game bar's Campaign tooltip, kept current on every page. */}
      <Suspense fallback={null}>
        <CampaignTip />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <ErrorBoundary FallbackComponent={ErrorFallback}>
          <Routes>
            <Route
              path="/"
              element={
                <Page title="Lioneye" component={<RoutesContainer />} />
              }
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
            <Route
              path="/edit-route"
              element={
                <Page
                  title="Lioneye - Edit Route"
                  component={
                    <div className="page-narrow">
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
