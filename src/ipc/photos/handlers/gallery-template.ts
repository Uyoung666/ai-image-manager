export function buildHtmlGallery(
  photos: Array<{
    filename: string;
    width: number;
    height: number;
    tags: string[];
    exif: {
      camera?: string;
      lens?: string;
      focalLength?: string;
      aperture?: string;
      shutter?: string;
      iso?: number;
      dateTaken?: string;
    } | null;
  }>,
  locale = "zh-CN"
): string {
  const itemsJson = JSON.stringify(
    photos.map((p) => ({
      src: `photos/${p.filename}`,
      w: p.width,
      h: p.height,
      tags: p.tags,
      exif: p.exif
        ? {
            c: p.exif.camera,
            l: p.exif.lens,
            f: p.exif.focalLength,
            a: p.exif.aperture,
            s: p.exif.shutter,
            i: p.exif.iso,
            d: p.exif.dateTaken,
          }
        : null,
    }))
  );

  const photoCount = photos.length;
  // Build the HTML as concatenated strings to avoid template literal issues
  const css = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#08090a;--surface:#1c1e22;--surface-hover:#25272d;--fg:#f7f8f8;--fg2:#a1a1aa;--fg3:#6b6b75;--accent:#5e6ad2;--border:rgba(255,255,255,0.06);--radius:8px}
body{font-family:'Inter Variable',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
header{position:sticky;top:0;z-index:10;background:rgba(8,9,10,0.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:16px;font-weight:590;white-space:nowrap}
header .count{font-size:12px;color:var(--fg3)}
#search{flex:1;min-width:180px;max-width:400px;height:32px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--fg);padding:0 12px;font-size:13px;outline:none}
#search:focus{border-color:var(--accent)}
#search::placeholder{color:var(--fg3)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px;padding:4px}
.card{position:relative;aspect-ratio:1;overflow:hidden;border-radius:4px;cursor:pointer;background:var(--surface)}
.card img{width:100%;height:100%;object-fit:cover;transition:transform .3s ease}
.card:hover img{transform:scale(1.03)}
.card .overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.7) 0%,transparent 50%);opacity:0;transition:opacity .2s;display:flex;align-items:flex-end;padding:12px}
.card:hover .overlay{opacity:1}
.card .overlay .info{font-size:11px;color:#ccc}
.card .overlay .info .exif{font-size:10px;color:#999;margin-top:2px}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.92);display:none;align-items:center;justify-content:center;cursor:pointer}
.lightbox.open{display:flex}
.lightbox img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 60px rgba(0,0,0,0.6)}
.lightbox .close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.lightbox .close:hover{background:rgba(255,255,255,0.2)}
.lightbox .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.lightbox .nav:hover{background:rgba(255,255,255,0.2)}
.lightbox .nav.prev{left:16px}
.lightbox .nav.next{right:16px}
.lightbox .meta{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);border-radius:8px;padding:8px 16px;font-size:12px;color:var(--fg2);text-align:center;backdrop-filter:blur(8px)}
.lightbox .meta .tags{margin-top:4px;display:flex;gap:4px;justify-content:center;flex-wrap:wrap}
.lightbox .meta .tags span{padding:1px 6px;border-radius:4px;background:var(--accent);color:#fff;font-size:10px}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:50vh;color:var(--fg3);gap:8px}
.empty-state svg{width:48px;height:48px;opacity:0.3}
footer{text-align:center;padding:16px;font-size:11px;color:var(--fg3);border-top:1px solid var(--border);margin-top:16px}
footer a{color:var(--accent);text-decoration:none}
@media(max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}`;
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
      grid.innerHTML='<div class="empty-state"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>No matching photos</span></div>';
      return;
    }
    items.forEach(function(p,i){
      var card=document.createElement("div");
      card.className="card";
      card.innerHTML='<img src="'+p.src+'" alt="" loading="lazy"><div class="overlay"><div class="info">'+((p.exif&&p.exif.d)||'')+'</div></div>';
      card.addEventListener("click",function(){openLightbox(i);});
      grid.appendChild(card);
    });
    document.getElementById("count").textContent=items.length+" photos";
  }

  function openLightbox(idx){
    currentIdx=idx;
    var p=filteredData[idx];
    lbImg.src=p.src;
    var meta="";
    if(p.exif){
      var parts=[];
      if(p.exif.d) parts.push(p.exif.d);
      if(p.exif.c) parts.push(p.exif.c);
      if(p.exif.l) parts.push(p.exif.l);
      if(p.exif.f) parts.push(p.exif.f+"mm");
      if(p.exif.a) parts.push("f/"+p.exif.a);
      if(p.exif.s) parts.push(p.exif.s+"s");
      if(p.exif.i) parts.push("ISO "+p.exif.i);
      meta=parts.join(" &middot; ");
    }
    if(p.tags.length) meta+='<div class="tags">'+p.tags.map(function(t){return '<span>'+t+'</span>';}).join("")+'</div>';
    lbMeta.innerHTML=meta;
    lb.classList.add("open");
  }

  function closeLightbox(){lb.classList.remove("open");currentIdx=-1;}
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
        var text=(p.tags.join(" ")+" "+(p.exif?Object.values(p.exif).join(" "):"")).toLowerCase();
        return text.indexOf(q)>-1;
      });
    }
    render(filteredData);
    currentIdx=-1;
  });

  render(filteredData);
})();`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Image Manager — Gallery Export</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>Gallery Export</h1>
  <span class="count" id="count">${photoCount} photos</span>
  <input id="search" type="text" placeholder="Filter by tag or EXIF...">
</header>
<div class="grid" id="grid"></div>
<div class="lightbox" id="lightbox">
  <button class="close" id="lb-close">&times;</button>
  <button class="nav prev" id="lb-prev">&larr;</button>
  <button class="nav next" id="lb-next">&rarr;</button>
  <img id="lb-img" src="" alt="">
  <div class="meta" id="lb-meta"></div>
</div>
<footer>
  Generated by <a href="https://github.com/Uyoung/ai-image-manager">AI Image Manager</a>
</footer>
<script>${script}</script>
</body>
</html>`;
}
