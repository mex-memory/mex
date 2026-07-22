from . import exported, models


def build_widget() -> models.Widget:
    return models.Widget(exported())
