from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/users/{user_id}")
@app.patch("/users/{user_id}")
async def update_user(user_id: str):
    return {"user_id": user_id}


@router.put("/users/{user_id}")
def replace_user(user_id: str):
    return {"user_id": user_id}


@router.options("/users")
@router.head("/users")
def inspect_users():
    return None


class AdminRoutes:
    @router.delete("/admin/{user_id}")
    def delete_user(self, user_id: str):
        return {"deleted": user_id}
