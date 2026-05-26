import { eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, photos, photoTags, tags } from "@/db/schema";
import { getThumbnailPath } from "@/services/thumbnailer";

export interface SharePhoto {
  aperture: string;
  camera: string;
  dateTaken: string;
  filename: string;
  focalLength: string;
  height: number;
  iso: string;
  lens: string;
  shutter: string;
  tags: string[];
  thumbnailBase64: string;
  width: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSharePageHtml(items: SharePhoto[], locale = "zh-CN"): string {
  const itemsJson = JSON.stringify(
    items.map((p) => ({
      fn: p.filename,
      dt: p.dateTaken,
      exif: {
        c: p.camera,
        l: p.lens,
        f: p.focalLength,
        a: p.aperture,
        s: p.shutter,
        i: p.iso,
      },
      tags: p.tags,
      w: p.width,
      h: p.height,
      thumb: p.thumbnailBase64,
    }))
  );

  const css = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#08090a;--surface:#1c1e22;--surface-hover:#25272d;--fg:#f7f8f8;--fg2:#a1a1aa;--fg3:#6b6b75;--accent:#5e6ad2;--accent-hover:#7c7fe0;--border:rgba(255,255,255,0.06);--radius:8px}
body{font-family:'Inter Variable',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;line-height:1.5}
header{position:sticky;top:0;z-index:10;background:rgba(8,9,10,0.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border);padding:16px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
header h1{font-size:18px;font-weight:590;letter-spacing:-0.01em}
header .count{font-size:12px;color:var(--fg3);font-weight:510}
#search{height:32px;width:260px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--fg);padding:0 12px;font-size:13px;outline:none;transition:border-color .15s}
#search:focus{border-color:var(--accent)}
#search::placeholder{color:var(--fg3)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;padding:8px;max-width:1600px;margin:0 auto}
.card{position:relative;overflow:hidden;border-radius:6px;background:var(--surface);cursor:pointer;transition:background .2s}
.card:hover{background:var(--surface-hover)}
.card img{width:100%;display:block;object-fit:cover;aspect-ratio:4/3}
.card .meta{padding:10px 14px 12px}
.card .meta .date{font-size:12px;font-weight:510;color:var(--fg)}
.card .meta .gear{font-size:11px;color:var(--fg2);margin-top:2px}
.card .meta .tags-row{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.card .meta .tags-row span{padding:1px 6px;border-radius:4px;background:rgba(94,106,210,0.15);color:var(--accent-hover);font-size:10px;font-weight:510}
.lightbox{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.94);display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;cursor:default}
.lightbox.open{display:flex}
.lightbox img{max-width:94vw;max-height:78vh;object-fit:contain;border-radius:4px}
.lightbox .lb-meta{color:var(--fg2);font-size:13px;text-align:center;max-width:600px;padding:0 20px}
.lightbox .lb-meta .lb-tags{display:flex;gap:4px;justify-content:center;flex-wrap:wrap;margin-top:6px}
.lightbox .lb-meta .lb-tags span{padding:2px 8px;border-radius:4px;background:var(--accent);color:#fff;font-size:11px}
.lightbox .close{position:absolute;top:20px;right:24px;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,0.08);color:var(--fg);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.lightbox .close:hover{background:rgba(255,255,255,0.16)}
.lightbox .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,0.08);color:var(--fg);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.lightbox .nav:hover{background:rgba(255,255,255,0.16)}
.lightbox .nav.prev{left:20px}
.lightbox .nav.next{right:20px}
footer{text-align:center;padding:24px 16px;font-size:11px;color:var(--fg3);border-top:1px solid var(--border);margin-top:16px}
footer a{color:var(--accent);text-decoration:none}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:50vh;color:var(--fg3);gap:8px}
@media(max-width:640px){.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:4px;padding:4px}
header{padding:12px 16px}header h1{font-size:14px}#search{width:100%;order:3;flex-basis:100%}}`;

  const script = `(function(){
var data=${itemsJson};
var grid=document.getElementById("grid");
var search=document.getElementById("search");
var lb=document.getElementById("lightbox");
var lbImg=document.getElementById("lb-img");
var lbMeta=document.getElementById("lb-meta");
var currentIdx=-1;
var filteredData=data.slice();

function render(items){
  grid.innerHTML="";
  if(items.length===0){
    grid.innerHTML='<div class="empty-state"><svg fill="none" stroke="currentColor" width="48" height="48" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>No matching photos</span></div>';
    return;
  }
  items.forEach(function(p,i){
    var card=document.createElement("div");
    card.className="card";
    var gear=[];
    if(p.exif.c) gear.push(p.exif.c);
    if(p.exif.l) gear.push(p.exif.l);
    var tagsHtml="";
    if(p.tags.length) tagsHtml='<div class="tags-row">'+p.tags.map(function(t){return '<span>'+t+'</span>';}).join("")+'</div>';
    card.innerHTML='<img src="'+p.thumb+'" alt="'+p.fn+'" loading="lazy"><div class="meta"><div class="date">'+p.dt+'</div><div class="gear">'+gear.join(" · ")+'</div>'+tagsHtml+'</div>';
    card.addEventListener("click",function(){openLightbox(i);});
    grid.appendChild(card);
  });
  document.getElementById("count").textContent=items.length+" photos";
}

function openLightbox(idx){
  currentIdx=idx;
  var p=filteredData[idx];
  lbImg.src=p.thumb;
  var parts=[];
  if(p.dt) parts.push(p.dt);
  if(p.exif.c) parts.push(p.exif.c);
  if(p.exif.l) parts.push(p.exif.l);
  if(p.exif.f) parts.push(p.exif.f+"mm f/"+p.exif.a);
  if(p.exif.s) parts.push(p.exif.s+"s ISO"+p.exif.i);
  var meta=parts.join(" · ");
  if(p.tags.length) meta+='<div class="lb-tags">'+p.tags.map(function(t){return '<span>'+t+'</span>';}).join("")+'</div>';
  lbMeta.innerHTML=meta;
  lb.classList.add("open");
}

function closeLightbox(){lb.classList.remove("open");}
function navLightbox(dir){
  var n=currentIdx+dir;
  if(n>=0&&n<filteredData.length) openLightbox(n);
}

document.getElementById("lb-close").addEventListener("click",function(e){e.stopPropagation();closeLightbox();});
document.getElementById("lb-prev").addEventListener("click",function(e){e.stopPropagation();navLightbox(-1);});
document.getElementById("lb-next").addEventListener("click",function(e){e.stopPropagation();navLightbox(1);});
lb.addEventListener("click",function(e){if(e.target===lb)closeLightbox();});
document.addEventListener("keydown",function(e){
  if(!lb.classList.contains("open")) return;
  if(e.key==="Escape") closeLightbox();
  if(e.key==="ArrowLeft") navLightbox(-1);
  if(e.key==="ArrowRight") navLightbox(1);
});
search.addEventListener("input",function(){
  var q=search.value.toLowerCase().trim();
  if(!q){filteredData=data.slice();}
  else{
    filteredData=data.filter(function(p){
      var text=(p.tags.join(" ")+" "+p.dt+" "+(p.exif?Object.values(p.exif).join(" "):"")).toLowerCase();
      return text.indexOf(q)>-1;
    });
  }
  render(filteredData);
  currentIdx=-1;
});

render(filteredData);
})();`;

  const title = `AI Image Manager — ${new Date().toLocaleDateString(locale)}`;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>Photo Share</h1>
  <span class="count" id="count">${items.length} photos</span>
  <input id="search" type="text" placeholder="搜索标签或 EXIF 信息...">
</header>
<div class="grid" id="grid"></div>
<div class="lightbox" id="lightbox">
  <button class="close" id="lb-close">&times;</button>
  <button class="nav prev" id="lb-prev">&larr;</button>
  <button class="nav next" id="lb-next">&rarr;</button>
  <img id="lb-img" src="" alt="">
  <div class="lb-meta" id="lb-meta"></div>
</div>
<footer>
  Generated by <a href="https://github.com/Uyoung666/ai-image-manager" target="_blank" rel="noopener">AI Image Manager</a>
</footer>
<script>${script}</script>
</body>
</html>`;
}

export async function generateSharePage(photoIds: number[], locale = "zh-CN"): Promise<string> {
  const db = getDatabase();

  const photoList = db
    .select()
    .from(photos)
    .where(inArray(photos.id, photoIds))
    .all();

  const sharePhotos: SharePhoto[] = [];

  for (const photo of photoList) {
    // Thumbnail base64
    let thumbnailBase64 = "";
    try {
      const thumbPath = getThumbnailPath(photo.path, "md");
      if (thumbPath) {
        const fs = await import("node:fs");
        if (fs.existsSync(thumbPath)) {
          const buf = fs.readFileSync(thumbPath);
          thumbnailBase64 = `data:image/jpeg;base64,${buf.toString("base64")}`;
        }
      }
    } catch {
      // Skip thumbnail on failure
    }

    // Fallback: generate inline thumbnail with sharp
    if (!thumbnailBase64) {
      try {
        const fs = await import("node:fs");
        if (fs.existsSync(photo.path)) {
          const sharp = (await import("sharp")).default;
          const buf = await sharp(photo.path)
            .resize(600, 450, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          thumbnailBase64 = `data:image/jpeg;base64,${buf.toString("base64")}`;
        }
      } catch {
        thumbnailBase64 = "";
      }
    }

    // Tags
    const photoTagRows = db
      .select({ name: tags.name })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(eq(photoTags.photoId, photo.id))
      .all();
    const tagNames = photoTagRows.map((t) => t.name);

    // EXIF
    const exif = db
      .select()
      .from(exifData)
      .where(eq(exifData.photoId, photo.id))
      .get();

    sharePhotos.push({
      filename: photo.filename,
      dateTaken: exif?.dateTaken
        ? new Date(exif.dateTaken).toLocaleDateString(locale)
        : new Date(photo.fileDate || Date.now()).toLocaleDateString(locale),
      camera: exif?.cameraModel ?? "",
      lens: exif?.lensModel ?? "",
      focalLength: exif?.focalLength?.toString() ?? "",
      aperture: exif?.aperture?.toString() ?? "",
      shutter: exif?.shutterSpeed ?? "",
      iso: exif?.iso?.toString() ?? "",
      tags: tagNames,
      width: photo.width ?? 0,
      height: photo.height ?? 0,
      thumbnailBase64,
    });
  }

  return buildSharePageHtml(sharePhotos, locale);
}
