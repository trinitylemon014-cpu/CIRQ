from flask import Blueprint, request, redirect, url_for, flash, g, jsonify, abort, current_app
from app.decorators import login_required
from app.extensions import limiter, db
from app.services import supabase_service as sb, cloudinary_service as cs, social
from app.services.cloudinary_service import UploadError
from app.services.moderation_service import check_text
from app.utils import iso, utcnow, parse_dt, hours_from_now, clean_text, normalize_username

bp = Blueprint("stories", __name__, url_prefix="/stories")


def active_stories(author_id):
    """Expiry is enforced in the query itself, never only in the browser."""
    return db().table("stories").select("*").eq("author_id", author_id).gt("expires_at", iso()) \
        .eq("moderation_status", "ok").order("created_at", desc=False).execute().data or []


@bp.post("")
@login_required
@limiter.limit("20 per hour")
def create():
    f = request.files.get("media")
    caption = clean_text(request.form.get("caption"), 150)
    ok, why = check_text(caption)
    if not ok:
        flash(why, "error")
        return redirect(url_for("feed.home"))
    try:
        info = cs.upload(f, "stories", g.user["id"])
    except UploadError as e:
        flash(str(e), "error")
        return redirect(url_for("feed.home"))
    sb.insert("stories", {"author_id": g.user["id"], "media_type": info["media_type"], "url": info["url"],
                          "public_id": info["public_id"], "delivery_type": info["delivery_type"], "caption": caption or None,
                          "expires_at": iso(hours_from_now(current_app.config["STORY_TTL_HOURS"]))})
    social.grant_achievement(g.user["id"], "storyteller")
    flash("Story shared for 24 hours.", "success")
    return redirect(url_for("feed.home"))


@bp.get("/api/<username>")
@login_required
def api(username):
    prof = sb.get("profiles", username=normalize_username(username))
    if not prof or prof["account_status"] != "approved" or not social.can_see_profile_content(g.user, prof) and prof["id"] != g.user["id"]:
        abort(404)
    if social.is_blocked(g.user["id"], prof["id"]):
        abort(404)
    # Private accounts only show stories to followers
    items = active_stories(prof["id"])
    seen = {r["story_id"] for r in sb.in_("story_views", "story_id", [s["id"] for s in items]) if r["viewer_id"] == g.user["id"]}
    return jsonify(user={"username": prof["username"], "name": prof["display_name"], "avatar": cs.avatar_src(prof, 80)},
                   me=prof["id"] == g.user["id"],
                   stories=[{"id": s["id"], "type": s["media_type"], "src": cs.media_src(s, 900), "caption": s["caption"],
                             "seen": s["id"] in seen, "expires_at": s["expires_at"],
                             "views": sb.count("story_views", story_id=s["id"]) if prof["id"] == g.user["id"] else None} for s in items])


@bp.post("/<story_id>/view")
@login_required
def view(story_id):
    s = sb.get("stories", id=story_id)
    exp = parse_dt(s["expires_at"]) if s else None
    if not s or not exp or exp < utcnow() or s["moderation_status"] != "ok":
        abort(404)
    author = sb.get("profiles", id=s["author_id"])
    if s["author_id"] != g.user["id"] and (not social.can_see_profile_content(g.user, author)):
        abort(404)
    if s["author_id"] != g.user["id"] and not sb.get("story_views", story_id=story_id, viewer_id=g.user["id"]):
        sb.insert("story_views", {"story_id": story_id, "viewer_id": g.user["id"]})
    return jsonify(ok=True)


@bp.post("/<story_id>/delete")
@login_required
def delete(story_id):
    s = sb.get("stories", id=story_id)
    if not s:
        abort(404)
    if s["author_id"] != g.user["id"]:
        abort(403)
    cs.destroy(s["public_id"], s["media_type"], s.get("delivery_type", "upload"))
    sb.delete("stories", id=story_id)
    if request.headers.get("X-Requested-With") == "fetch":
        return jsonify(ok=True)
    flash("Story deleted.", "info")
    return redirect(url_for("feed.home"))
