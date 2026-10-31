from flask import Blueprint, render_template, request, redirect, url_for, flash, g, abort, jsonify, session, current_app
from app.decorators import login_required
from app.extensions import limiter, db
from app.services import supabase_service as sb, cloudinary_service as cs, social, auth_service
from app.services.cloudinary_service import UploadError
from app.services.notification_service import notify
from app.utils import normalize_username, clean_text, iso, password_problems, TIERS, tier_for

bp = Blueprint("profiles", __name__)


def _profile_or_404(username):
    p = sb.get("profiles", username=normalize_username(username))
    if not p or (p["account_status"] != "approved" and g.user["id"] != p["id"] and g.user.get("role") != "admin"):
        abort(404)
    return p


@bp.get("/u/<username>")
@login_required
def view(username):
    prof = _profile_or_404(username)
    me = g.user
    if social.is_blocked(me["id"], prof["id"]) and prof["id"] != me["id"]:
        abort(404)
    stats = social.profile_stats(prof)
    school = sb.get("schools", id=prof["school_id"]) if prof.get("school_id") else None
    can_see = social.can_see_profile_content(me, prof)
    tab = request.args.get("tab", "posts")
    items, cursor = [], None
    if can_see:
        n = current_app.config["PAGE_SIZE"]
        q = db().table("posts").select("*").eq("author_id", prof["id"]).eq("moderation_status", "ok") \
            .eq("kind", "reel" if tab == "reels" else "post").is_("community_id", "null").order("created_at", desc=True).limit(n + 1)
        if request.args.get("before"):
            q = q.lt("created_at", request.args["before"])
        rows = q.execute().data or []
        if me["id"] != prof["id"] and not social.is_following(me["id"], prof["id"]):
            rows = [r for r in rows if r["visibility"] == "public"]
        cursor = rows[n - 1]["created_at"] if len(rows) > n else None
        items = social.hydrate_posts(rows[:n], me["id"])
    if request.args.get("partial"):
        return render_template("partials/post_list.html", posts=items, cursor=cursor)
    return render_template("profiles/view.html", prof=prof, stats=stats, school=school, can_see=can_see, items=items, cursor=cursor,
                           tab=tab, following=social.is_following(me["id"], prof["id"]),
                           achievements=[a for a in social.user_achievements(prof["id"]) if a["earned"]])


@bp.post("/u/<username>/follow")
@login_required
@limiter.limit("120 per hour")
def follow(username):
    prof = _profile_or_404(username)
    me = g.user["id"]
    if prof["id"] == me or social.is_blocked(me, prof["id"]):
        abort(400)
    if social.is_following(me, prof["id"]):
        sb.delete("follows", follower_id=me, followee_id=prof["id"])
        following = False
    else:
        sb.insert("follows", {"follower_id": me, "followee_id": prof["id"]})
        following = True
        notify(prof["id"], "follow", me, "profile", me)
        social.grant_achievement(me, "first_follow")
        social.grant_achievement(prof["id"], "first_follower")
    count = social.follower_count(prof["id"])
    if request.headers.get("X-Requested-With") == "fetch":
        return jsonify(following=following, followers=count)
    return redirect(url_for("profiles.view", username=prof["username"]))


@bp.post("/u/<username>/block")
@login_required
def block(username):
    prof = _profile_or_404(username)
    me = g.user["id"]
    if prof["id"] == me:
        abort(400)
    if sb.get("blocks", blocker_id=me, blocked_id=prof["id"]):
        sb.delete("blocks", blocker_id=me, blocked_id=prof["id"])
        flash(f"Unblocked @{prof['username']}.", "info")
    else:
        sb.insert("blocks", {"blocker_id": me, "blocked_id": prof["id"]})
        sb.delete("follows", follower_id=me, followee_id=prof["id"])
        sb.delete("follows", follower_id=prof["id"], followee_id=me)
        flash(f"Blocked @{prof['username']}. They can't see your profile or message you.", "success")
    return redirect(url_for("feed.home"))


@bp.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    me = g.user
    if request.method == "POST":
        action = request.form.get("action", "profile")
        if action == "profile":
            display = clean_text(request.form.get("display_name"), 40)
            bio = clean_text(request.form.get("bio"), 200)
            private = bool(request.form.get("is_private"))
            if len(display) < 2:
                flash("Display name must be at least 2 characters.", "error")
                return redirect(url_for("profiles.settings"))
            values = {"display_name": display, "bio": bio or None, "is_private": private}
            f = request.files.get("avatar")
            if f and f.filename:
                try:
                    info = cs.upload(f, "avatars", me["id"], allow_video=False)
                    cs.destroy(me.get("avatar_public_id"))
                    values.update(avatar_url=info["url"], avatar_public_id=info["public_id"])
                except UploadError as e:
                    flash(str(e), "error")
                    return redirect(url_for("profiles.settings"))
            sb.update("profiles", values, id=me["id"])   # only whitelisted columns can ever be written here
            if private:
                sb.update("posts", {"visibility": "followers"}, author_id=me["id"], visibility="public")
            flash("Profile saved.", "success")
        elif action == "password":
            cur, new, new2 = request.form.get("current", ""), request.form.get("new", ""), request.form.get("new2", "")
            errs = password_problems(new, me["username"]) + (["Passwords don't match."] if new != new2 else [])
            if not auth_service.verify_password(me["id"], cur):
                errs.append("Your current password isn't right.")
            if errs:
                for e in errs:
                    flash(e, "error")
            else:
                auth_service.set_password(me["id"], new)
                epoch = me.get("session_epoch", 0) + 1
                sb.update("profiles", {"session_epoch": epoch}, id=me["id"])   # signs out other devices
                session["epoch"] = epoch
                flash("Password changed. Other devices were signed out.", "success")
        elif action == "delete":
            if not auth_service.verify_password(me["id"], request.form.get("confirm_password", "")) or request.form.get("confirm_text") != "DELETE":
                flash("Type DELETE and your password to confirm.", "error")
            else:
                _erase_account(me)
                session.clear()
                flash("Your account and its content were deleted.", "info")
                return redirect(url_for("auth.landing"))
        return redirect(url_for("profiles.settings"))
    blocked = sb.by_id("profiles", [b["blocked_id"] for b in sb.select("blocks", blocker_id=me["id"])])
    return render_template("profiles/settings.html", blocked=list(blocked.values()))


def _erase_account(me):
    """Delete the person's Cloudinary files, then their auth user (database rows cascade)."""
    for m in sb.select("post_media", owner_id=me["id"]):
        cs.destroy(m["public_id"], m["media_type"], m.get("delivery_type", "upload"))
    for s in sb.select("stories", author_id=me["id"]):
        cs.destroy(s["public_id"], s["media_type"], s.get("delivery_type", "upload"))
    cs.destroy(me.get("avatar_public_id"))
    auth_service.delete_auth_user(me["id"])


@bp.get("/status")
@login_required
def status():
    me = g.user
    stats = social.profile_stats(me)
    ach = social.user_achievements(me["id"])
    return render_template("profiles/status.html", stats=stats, tiers=TIERS, achievements=ach)
