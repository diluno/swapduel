extends Control

const UiTheme = preload("res://game/presentation/ui_theme.gd")


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	resized.connect(queue_redraw)


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("#fff7ee"))
	draw_circle(
		Vector2(size.x * 0.5, -size.x * 0.12),
		size.x * 0.78,
		Color(1.0, 1.0, 1.0, 0.62),
	)
	draw_circle(
		Vector2(-size.x * 0.18, size.y * 0.74),
		size.x * 0.66,
		Color(UiTheme.CORAL_SOFT, 0.10),
	)
	draw_circle(
		Vector2(size.x * 1.12, size.y * 0.42),
		size.x * 0.54,
		Color(0.37, 0.82, 0.63, 0.055),
	)
	var spacing := 46.0
	var dot_color := Color(0.78, 0.61, 0.51, 0.075)
	var rows := ceili(size.y / spacing)
	var columns := ceili(size.x / spacing)
	for row in rows:
		for column in columns:
			var offset := spacing * 0.5 if row % 2 == 1 else 0.0
			draw_circle(
				Vector2(
					column * spacing + offset,
					row * spacing + spacing * 0.35,
				),
				1.5,
				dot_color,
			)
