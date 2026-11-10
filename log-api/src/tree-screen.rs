//! Whether Path of Exile's passive tree is open: the game's log doesn't say, so the in-game
//! bar looks for the tree's "Skills" header, centered at the top of the game window (the
//! Tree tooltip then opens by itself, overlay.rs).
//!
//! The game scales its interface with the window's height and keeps the header centered, so
//! one picture of it (taken at 1080 pixels high) is found at any size: the spot is read off
//! the screen, scaled to the picture's size and compared in grayscale, allowing a few
//! pixels of drift. Pixels the bar's own window covers can be left out of the comparison;
//! with too much covered (or the "Skills" title), the check doesn't answer.

/// The header's plaque ("Skills" on gold) at 1080 pixels high: 8-bit grayscale, row by row.
static HEADER: &[u8; HEADER_W * HEADER_H] = include_bytes!("../assets/tree-header.gray");
pub const HEADER_W: usize = 196;
pub const HEADER_H: usize = 26;
/// Its left edge from the window's center, and its top from the window's top, at 1080 high.
pub const HEADER_LEFT: i32 = -98;
pub const HEADER_TOP: i32 = 55;
/// The window height the picture was taken at.
const BASE_HEIGHT: f64 = 1080.0;
/// How far the header may sit from its place (pixels at 1080 high), each way.
const SLACK: usize = 6;
/// Matches at least this well (1 is identical): the tree is open.
pub const OPEN_SCORE: f32 = 0.8;
/// The "Skills" title's columns in the picture: most of it must be compared, since the
/// plaque alone (another screen with the same frame) is no proof.
const TITLE_X: std::ops::Range<usize> = 68..132;
/// Windows this short show no tree worth finding (and nothing to measure).
const MIN_HEIGHT: i32 = 300;

/// What's compared: the picture plus the slack on every side.
const AREA_W: usize = HEADER_W + 2 * SLACK;
const AREA_H: usize = HEADER_H + 2 * SLACK;

/// Where to read, in client pixels of a `width` × `height` window: x, y, width, height.
/// None for a window too small.
pub fn read_area(width: i32, height: i32) -> Option<(i32, i32, i32, i32)> {
    if width <= 0 || height < MIN_HEIGHT {
        return None;
    }
    let scale = height as f64 / BASE_HEIGHT;
    let x = width as f64 / 2.0 + (HEADER_LEFT as f64 - SLACK as f64) * scale;
    let y = (HEADER_TOP as f64 - SLACK as f64) * scale;
    let w = (AREA_W as f64 * scale).round().max(1.0);
    let h = (AREA_H as f64 * scale).round().max(1.0);
    Some((x.round() as i32, y.round() as i32, w as i32, h as i32))
}

/// Brightness of a blue, green, red pixel (as the picture was made).
pub fn gray(b: u8, g: u8, r: u8) -> u8 {
    ((77 * r as u32 + 150 * g as u32 + 29 * b as u32) >> 8) as u8
}

/// How well the header matches what was read: `pixels` (grayscale, `width` × `height`, row
/// by row) is the spot `read_area` gave; `usable` marks the pixels not covered by the bar
/// (empty: all are). From -1 to 1; None when too little of it could be compared.
pub fn score(pixels: &[u8], width: usize, height: usize, usable: &[bool]) -> Option<f32> {
    if width == 0 || height == 0 || pixels.len() != width * height {
        return None;
    }
    if !usable.is_empty() && usable.len() != pixels.len() {
        return None;
    }
    let (area, area_ok) = resample(pixels, width, height, usable);

    let mut best: Option<f32> = None;
    for dy in 0..=2 * SLACK {
        for dx in 0..=2 * SLACK {
            let (mut n, mut sr, mut sc, mut srr, mut scc, mut src) =
                (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
            let mut title = 0usize;
            for y in 0..HEADER_H {
                let row = (y + dy) * AREA_W + dx;
                for x in 0..HEADER_W {
                    if !area_ok[row + x] {
                        continue;
                    }
                    let r = HEADER[y * HEADER_W + x] as f64;
                    let c = area[row + x] as f64;
                    n += 1.0;
                    if TITLE_X.contains(&x) {
                        title += 1;
                    }
                    sr += r;
                    sc += c;
                    srr += r * r;
                    scc += c * c;
                    src += r * c;
                }
            }
            // At least half the header and most of its title, or the bar covers too much
            // to tell.
            if n < (HEADER_W * HEADER_H / 2) as f64 || title * 4 < TITLE_X.len() * HEADER_H * 3 {
                continue;
            }
            let vr = n * srr - sr * sr;
            let vc = n * scc - sc * sc;
            // A flat spot (a black screen, a loading screen) matches nothing.
            let ncc = if vr <= 0.0 || vc <= 1e-6 * n * n {
                0.0
            } else {
                ((n * src - sr * sc) / (vr * vc).sqrt()) as f32
            };
            best = Some(best.map_or(ncc, |b: f32| b.max(ncc)));
        }
    }
    best
}

/// What was read, at the picture's scale (AREA_W × AREA_H): each pixel the average of the
/// pixels it covers. A pixel is usable when every pixel it covers is.
fn resample(pixels: &[u8], width: usize, height: usize, usable: &[bool]) -> (Vec<f32>, Vec<bool>) {
    let sx = width as f64 / AREA_W as f64;
    let sy = height as f64 / AREA_H as f64;
    let mut out = vec![0f32; AREA_W * AREA_H];
    let mut ok = vec![true; AREA_W * AREA_H];
    for ty in 0..AREA_H {
        let (y0, y1) = (ty as f64 * sy, (ty + 1) as f64 * sy);
        for tx in 0..AREA_W {
            let (x0, x1) = (tx as f64 * sx, (tx + 1) as f64 * sx);
            let (mut sum, mut weight) = (0f64, 0f64);
            let mut all_usable = true;
            let mut py = y0.floor() as usize;
            while (py as f64) < y1 && py < height {
                let wy = (y1.min(py as f64 + 1.0) - y0.max(py as f64)).max(0.0);
                let mut px = x0.floor() as usize;
                while (px as f64) < x1 && px < width {
                    let wx = (x1.min(px as f64 + 1.0) - x0.max(px as f64)).max(0.0);
                    let i = py * width + px;
                    if wx * wy > 0.0 {
                        sum += pixels[i] as f64 * wx * wy;
                        weight += wx * wy;
                        if !usable.is_empty() && !usable[i] {
                            all_usable = false;
                        }
                    }
                    px += 1;
                }
                py += 1;
            }
            let t = ty * AREA_W + tx;
            out[t] = if weight > 0.0 {
                (sum / weight) as f32
            } else {
                0.0
            };
            ok[t] = all_usable && weight > 0.0;
        }
    }
    (out, ok)
}

/// Where the header's spot is on the screen for the game window `game` (screen pixels);
/// None when it can't be measured (minimized, or too small).
#[cfg(windows)]
pub fn screen_spot(
    game: windows_sys::Win32::Foundation::HWND,
) -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::GetClientRect,
    };
    let mut client: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetClientRect(game, &mut client) } == 0 {
        return None;
    }
    let (x, y, w, h) = read_area(client.right - client.left, client.bottom - client.top)?;
    let mut origin = POINT { x, y };
    if unsafe { ClientToScreen(game, &mut origin) } == 0 {
        return None;
    }
    Some(RECT {
        left: origin.x,
        top: origin.y,
        right: origin.x + w,
        bottom: origin.y + h,
    })
}

/// Reads the header's `spot` (from `screen_spot`) off the screen, leaving out `cover` (the
/// bar's window, in screen pixels, when it shows in screen reads): Some(true) when the tree
/// is open, Some(false) when it isn't, None when it can't tell (the bar is in the way).
#[cfg(windows)]
pub fn tree_open(
    spot: windows_sys::Win32::Foundation::RECT,
    cover: Option<windows_sys::Win32::Foundation::RECT>,
) -> Option<bool> {
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, ReleaseDC, SRCCOPY, SelectObject,
    };

    let origin = (spot.left, spot.top);
    let (w, h) = (spot.right - spot.left, spot.bottom - spot.top);
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut pixels = vec![0u8; (w * h) as usize];
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return None;
        }
        let memory = CreateCompatibleDC(screen);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative: rows top to bottom.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = if memory.is_null() {
            std::ptr::null_mut()
        } else {
            CreateDIBSection(
                memory,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            )
        };
        let mut read = false;
        if !bitmap.is_null() && !bits.is_null() {
            let old = SelectObject(memory, bitmap);
            read = BitBlt(memory, 0, 0, w, h, screen, origin.0, origin.1, SRCCOPY) != 0;
            // Drawing into a DIB section may be batched: done before its bits are read.
            if read {
                GdiFlush();
                let bgra = std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize);
                for (i, px) in bgra.chunks_exact(4).enumerate() {
                    pixels[i] = gray(px[0], px[1], px[2]);
                }
            }
            SelectObject(memory, old);
        }
        if !bitmap.is_null() {
            DeleteObject(bitmap);
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
        ReleaseDC(std::ptr::null_mut(), screen);
        if !read {
            return None;
        }
    }

    let usable = usable_pixels(spot, cover);
    score(&pixels, w as usize, h as usize, &usable).map(|s| s >= OPEN_SCORE)
}

/// Whether a read of `spot` could answer with `cover` (the bar's window) left out: enough
/// of the header and its title still shows.
#[cfg(windows)]
pub fn can_answer(
    spot: windows_sys::Win32::Foundation::RECT,
    cover: windows_sys::Win32::Foundation::RECT,
) -> bool {
    let (w, h) = (spot.right - spot.left, spot.bottom - spot.top);
    if w <= 0 || h <= 0 {
        return false;
    }
    let usable = usable_pixels(spot, Some(cover));
    // Any pixels do: score is None only when too few could be compared.
    score(
        &vec![0u8; (w * h) as usize],
        w as usize,
        h as usize,
        &usable,
    )
    .is_some()
}

/// Which pixels of `spot` show the game: those outside `cover` (empty: all of them).
#[cfg(windows)]
fn usable_pixels(
    spot: windows_sys::Win32::Foundation::RECT,
    cover: Option<windows_sys::Win32::Foundation::RECT>,
) -> Vec<bool> {
    let (w, h) = (spot.right - spot.left, spot.bottom - spot.top);
    match cover {
        Some(c)
            if c.left < spot.right
                && c.right > spot.left
                && c.top < spot.bottom
                && c.bottom > spot.top =>
        {
            (0..h)
                .flat_map(|py| (0..w).map(move |px| (px, py)))
                .map(|(px, py)| {
                    let (sx, sy) = (spot.left + px, spot.top + py);
                    !(sx >= c.left && sx < c.right && sy >= c.top && sy < c.bottom)
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The header's spot read from a 2560 × 1080 game window with the tree open (the screen
    /// around it as the game drew it): read_area's size at that height.
    static OPEN_1080: &[u8] = include_bytes!("../assets/test/tree-open-2560x1080.gray");

    #[test]
    fn read_area_scales_with_height() {
        assert_eq!(read_area(2560, 1080), Some((1176, 49, 208, 38)));
        // Twice as high: twice the size, still centered.
        let (x, y, w, h) = read_area(2560, 2160).unwrap();
        assert_eq!((y, w, h), (98, 416, 76));
        assert_eq!(x + w / 2, 1280);
        assert_eq!(read_area(800, 200), None);
    }

    #[test]
    fn finds_the_open_tree() {
        let s = score(OPEN_1080, AREA_W, AREA_H, &[]).unwrap();
        assert!(s > 0.98, "score {s}");
    }

    #[test]
    fn finds_it_shifted() {
        // The same spot read 3 pixels to the right and 2 down: still found.
        let mut moved = vec![0u8; AREA_W * AREA_H];
        for y in 0..AREA_H {
            for x in 0..AREA_W {
                let (sx, sy) = (x.saturating_sub(3), y.saturating_sub(2));
                moved[y * AREA_W + x] = OPEN_1080[sy * AREA_W + sx];
            }
        }
        assert!(score(&moved, AREA_W, AREA_H, &[]).unwrap() > 0.95);
    }

    #[test]
    fn a_flat_screen_is_not_the_tree() {
        let black = vec![0u8; AREA_W * AREA_H];
        assert_eq!(score(&black, AREA_W, AREA_H, &[]), Some(0.0));
    }

    #[test]
    fn the_header_without_its_title_is_not_the_tree() {
        // The plaque with "Skills" painted over in the plaque's own color.
        let mut blank = OPEN_1080.to_vec();
        let fill = OPEN_1080[(SLACK + 4) * AREA_W + SLACK + 20];
        for y in SLACK + 3..SLACK + 23 {
            for x in SLACK + 70..SLACK + 132 {
                blank[y * AREA_W + x] = fill;
            }
        }
        assert!(score(&blank, AREA_W, AREA_H, &[]).unwrap() < OPEN_SCORE);
    }

    #[test]
    fn the_bar_over_part_of_it_is_left_out() {
        // The bar covers the left third: the rest still matches.
        let mut covered = OPEN_1080.to_vec();
        let mut usable = vec![true; covered.len()];
        for y in 0..AREA_H {
            for x in 0..AREA_W / 3 {
                covered[y * AREA_W + x] = 30;
                usable[y * AREA_W + x] = false;
            }
        }
        assert!(score(&covered, AREA_W, AREA_H, &usable).unwrap() > 0.98);
        // Covering the title: no answer, since the plaque alone is no proof.
        let mut usable = vec![true; covered.len()];
        for y in 0..AREA_H {
            for x in SLACK + 60..SLACK + 140 {
                usable[y * AREA_W + x] = false;
            }
        }
        assert_eq!(score(&covered, AREA_W, AREA_H, &usable), None);
        // Covering most of it: no answer.
        let usable = vec![false; covered.len()];
        assert_eq!(score(&covered, AREA_W, AREA_H, &usable), None);
    }
}
