from flask import Flask, Blueprint

app = Flask(__name__)
admin = Blueprint("admin", __name__)


@app.route("/health")
def health():
    return {"status": "ok"}


@app.route("/users/<int:user_id>", methods=["POST", "PUT"])
async def replace_user(user_id):
    return {"user_id": user_id}


@app.get("/ready")
def ready():
    return None


@admin.route("/settings", methods=["DELETE"])
def delete_settings():
    return None


@admin.post("/settings")
def create_settings():
    return None


# A blank line and a comment are legal between decorator and handler.
@admin.route("/cache")

# expired entries
def clear_cache():
    return None


class Custom:
    @app.route("/probe")
    def probe(self):
        return None

ops = Blueprint("ops", __name__, url_prefix="/admin")


@ops.get("/settings")
def admin_settings():
    return None
