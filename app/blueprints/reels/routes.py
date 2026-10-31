from flask import Blueprint, make_response, render_template, request, redirect, url_for, flash, g, current_app, abort
from app.decorators import login_required
from app.extensions import limiter, db
from app.services import supabase_service as sb, cloudinary_service as cs, social
from app.services.cloudinary_service import UploadError
from app.services.moderation_service import check_text
from app.utils import clean_text

bp = Blueprint("reels", __name__)
PER_PAGE = 5   # only a handful of videos are ever loaded at once


@bp.get("/reels")
@login_required
def index():
    me = g.user
    before = request.args.get("before")
    q = db().table("posts").select("*").eq("kind", "reel").eq("visibility", "public").eq("moderation_status", "ok") \
        .is_("community_id", "null").order("created_at", desc=True).limit(PER_PAGE + 1)
    if before:
        q = q.lt("created_at", before)
    rows = q.execute().data or []
    cursor = rows[PER_PAGE - 1]["created_at"] if len(rows) > PER_PAGE else None
    hidden = social.blocked_between(me["id"])
    reels = [r for r in social.hydrate_posts(rows[:PER_PAGE], me["id"])
             if r["author_id"] not in hidden and r["author"]["account_status"] == "approved" and not r["author"].get("is_private")]
    following = set(social.following_ids(me["id"]))
    if request.args.get("partial"):
        resp = make_response(render_template("reels/_items.html", reels=reels, cursor=cursor, following=following))
        resp.headers["X-Next-Cursor"] = cursor or ""
        return resp
    return render_template("reels/index.html", reels=reels, cursor=cursor, following=following)


@bp.get("/reels/new")
@login_required
def new():
    return render_template("reels/new.html")


@bp.post("/reels")
@login_required
@limiter.limit("10 per hour")
def create():
    f = request.files.get("video")
    caption = clean_text(request.form.get("caption"), 300)
    ok, why = check_text(caption)
    if not ok:
        flash(why, "error")
        return redirect(url_for("reels.new"))
    try:
        kind, _, _ = cs.validate(f, allow_image=False)
        info = cs.upload(f, "reels", g.user["id"], allow_image=False)
    except UploadError as e:
        flash(str(e), "error")
        return redirect(url_for("reels.new"))
    vis = "followers" if g.user.get("is_private") else "public"
    post = sb.insert("posts", {"author_id": g.user["id"], "kind": "reel", "caption": caption or None, "visibility": vis})
    sb.insert("post_media", {"post_id": post["id"], "owner_id": g.user["id"], **info})
    social.grant_achievement(g.user["id"], "reel_maker")
    flash("Reel posted!", "success")
    return redirect(url_for("reels.index"))
