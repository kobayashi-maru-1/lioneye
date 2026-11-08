//! The guide's requests for PoB build files (pob-files.rs): whether PoB Community and PoB
//! Redux are installed, Open (Windows' dialog), reading the linked file again, saving a
//! pasted build as a file, and Edit (the chosen PoB opened on the file). They read or write files and start PoB, so
//! only a page on this PC itself may make them: never another device (`--address
//! 0.0.0.0`) or a site pointed here by name.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::pob_files;
use crate::server::{AppState, local_host, local_origin};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/pob/home", get(home))
        .route("/api/pob/open", post(open))
        .route("/api/pob/read", post(read))
        // A big build's XML can pass axum's 2 MB default.
        .route(
            "/api/pob/save",
            post(save).layer(DefaultBodyLimit::max(pob_files::MAX_BUILD as usize)),
        )
        .route("/api/pob/edit", post(edit))
}

fn this_pc(peer: &SocketAddr, headers: &HeaderMap) -> bool {
    peer.ip().is_loopback() && local_origin(headers) && local_host(headers) && same_origin(headers)
}

/// A browser page asking is the guide itself (its Origin is the address it asked), not
/// another local web app: Open takes no JSON, so another app's form post would reach it.
pub(crate) fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true; // not a browser page
    };
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    match (origin.to_str(), host) {
        (Ok(origin), Some(host)) => origin
            .strip_prefix("http://")
            .is_some_and(|authority| authority.eq_ignore_ascii_case(host)),
        _ => false,
    }
}

/// A failure as the page shows it: "File not found" is 404 (the linked file moved).
fn failed(msg: String) -> Response {
    let status = if msg == pob_files::NOT_FOUND {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, msg).into_response()
}

/// Whether PoB Community (`installed`, with its builds folder) and PoB Redux (`redux`) are
/// installed: the guide shows Edit for the one its Editor setting picks.
async fn home(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if !this_pc(&peer, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let home = tokio::task::spawn_blocking(|| {
        let pob = pob_files::find();
        serde_json::json!({
            "installed": pob.is_some(),
            "builds": pob.as_ref().map(|pob| pob.builds_dir().to_string_lossy().into_owned()),
            "redux": pob_files::find_redux().is_some(),
        })
    })
    .await;
    match home {
        Ok(home) => Json(home).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A build file and its XML.
#[derive(Serialize)]
struct BuildFile {
    path: String,
    xml: String,
}

fn build_file(path: &Path, xml: String) -> Response {
    Json(BuildFile {
        path: path.to_string_lossy().into_owned(),
        xml,
    })
    .into_response()
}

/// Windows' Open dialog (in PoB's builds folder, else Downloads): the chosen build, or
/// `null` when cancelled.
async fn open(ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if !this_pc(&peer, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let chosen = tokio::task::spawn_blocking(|| {
        let pob = pob_files::find();
        let dir = pob_files::open_dir(pob.as_ref());
        let path = pob_files::open_dialog(dir.as_deref())?;
        Some(pob_files::read_build(&path).map(|xml| (path, xml)))
    })
    .await;
    match chosen {
        Ok(None) => Json(serde_json::Value::Null).into_response(),
        Ok(Some(Ok((path, xml)))) => build_file(&path, xml),
        Ok(Some(Err(msg))) => failed(msg),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct PathRequest {
    path: String,
}

/// The linked build file, read again (after a save in PoB, or when the guide starts).
async fn read(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PathRequest>,
) -> Response {
    if !this_pc(&peer, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = PathBuf::from(request.path);
    let file = path.clone();
    match tokio::task::spawn_blocking(move || pob_files::read_build(&file)).await {
        Ok(Ok(xml)) => build_file(&path, xml),
        Ok(Err(msg)) => failed(msg),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct SaveRequest {
    name: String,
    xml: String,
    /// Whose builds folder (missing: PoB Community's).
    #[serde(default)]
    editor: pob_files::Editor,
}

/// A pasted build saved as a new file in the chosen PoB's builds folder (Edit on a pasted
/// code).
async fn save(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<SaveRequest>,
) -> Response {
    if !this_pc(&peer, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let saved = tokio::task::spawn_blocking(move || {
        let dir = pob_files::builds_dir(request.editor)?;
        pob_files::save_build(&dir, &request.name, &request.xml)
    })
    .await;
    match saved {
        Ok(Ok(path)) => Json(serde_json::json!({ "path": path.to_string_lossy() })).into_response(),
        Ok(Err(msg)) => failed(msg),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct EditRequest {
    path: String,
    /// Which PoB (missing: PoB Community).
    #[serde(default)]
    editor: pob_files::Editor,
}

/// Opens the chosen PoB on the linked build file.
async fn edit(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<EditRequest>,
) -> Response {
    if !this_pc(&peer, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Only a local file named by a full path, as the guide links: never a network path
    // (checking one contacts that server) or a relative name PoB could read as a switch.
    let Some(path) = pob_files::linkable(&request.path) else {
        return failed(pob_files::NOT_FOUND.into());
    };
    let editor = request.editor;
    let opened = tokio::task::spawn_blocking(move || pob_files::edit_with(editor, &path)).await;
    match opened {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(msg)) => failed(msg),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
