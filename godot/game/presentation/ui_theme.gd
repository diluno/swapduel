extends RefCounted

const FREDOKA_SEMIBOLD_PATH := "res://assets/fonts/fredoka/Fredoka-SemiBold.ttf"
const FREDOKA_BOLD_PATH := "res://assets/fonts/fredoka/Fredoka-Bold.ttf"
const NUNITO_SEMIBOLD_PATH := "res://assets/fonts/nunito/Nunito-SemiBold.ttf"
const NUNITO_BOLD_PATH := "res://assets/fonts/nunito/Nunito-Bold.ttf"
const NUNITO_EXTRABOLD_PATH := "res://assets/fonts/nunito/Nunito-ExtraBold.ttf"
const NUNITO_BLACK_PATH := "res://assets/fonts/nunito/Nunito-Black.ttf"

const CREAM := Color("#fff4e8")
const CREAM_SOFT := Color("#ffead6")
const WHITE := Color("#fffdf9")
const PEACH := Color("#ffd8b8")
const PEACH_DEEP := Color("#f6c29a")
const CORAL := Color("#ff8c66")
const CORAL_DEEP := Color("#ed6a45")
const CORAL_DARK := Color("#d95832")
const CORAL_SOFT := Color("#ffb59a")
const INK := Color("#6e5648")
const INK_SOFT := Color("#a5806a")
const INK_FAINT := Color("#c9b4a5")
const DANGER := Color("#f0606c")

static var _fonts: Dictionary = {}


static func create() -> Theme:
	var result := Theme.new()
	result.default_font = body_font(600)
	result.default_font_size = 15
	result.set_font("font", "Label", body_font(600))
	result.set_font("font", "Button", display_font(600))
	result.set_font_size("font_size", "Button", 15)
	result.set_color("font_color", "Label", INK)
	result.set_color("font_color", "Button", INK)
	result.set_color("font_hover_color", "Button", INK)
	result.set_color("font_pressed_color", "Button", WHITE)
	result.set_color("font_focus_color", "Button", INK)
	result.set_color("font_disabled_color", "Button", Color(INK, 0.42))
	result.set_constant("outline_size", "Label", 0)
	result.set_constant("h_separation", "Button", 8)
	return result


static func display_font(weight: int = 600) -> Font:
	return _font_file(
		FREDOKA_BOLD_PATH if weight >= 700 else FREDOKA_SEMIBOLD_PATH,
	)


static func body_font(weight: int = 600) -> Font:
	var path := NUNITO_SEMIBOLD_PATH
	if weight >= 900:
		path = NUNITO_BLACK_PATH
	elif weight >= 800:
		path = NUNITO_EXTRABOLD_PATH
	elif weight >= 700:
		path = NUNITO_BOLD_PATH
	return _font_file(path)


static func panel_style(
	color: Color = WHITE,
	radius: int = 26,
	border_color: Color = Color.TRANSPARENT,
	border_width: int = 0,
	shadow_size: int = 0,
) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.border_color = border_color
	style.set_border_width_all(border_width)
	style.set_corner_radius_all(radius)
	if shadow_size > 0:
		style.shadow_color = Color(0.42, 0.25, 0.17, 0.13)
		style.shadow_size = shadow_size
		style.shadow_offset = Vector2(0.0, shadow_size * 0.5)
	return style


static func button_style(
	kind: StringName,
	state: StringName = &"normal",
) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.set_corner_radius_all(26)
	style.content_margin_left = 16
	style.content_margin_right = 16
	style.content_margin_top = 12
	style.content_margin_bottom = 12
	match kind:
		&"primary":
			style.bg_color = (
				CORAL_DARK
				if state == &"pressed"
				else CORAL_DEEP if state == &"hover" else CORAL
			)
			style.border_color = (
				Color(1.0, 1.0, 1.0, 0.22)
				if state == &"pressed"
				else Color(1.0, 1.0, 1.0, 0.5)
			)
			style.set_border_width_all(2)
			style.shadow_color = Color(0.76, 0.25, 0.12, 0.3)
			style.shadow_size = 4 if state != &"pressed" else 1
			style.shadow_offset = Vector2(0.0, 4.0 if state != &"pressed" else 1.0)
		&"ghost":
			style.bg_color = (
				Color(1.0, 0.96, 0.91, 0.72)
				if state != &"pressed"
				else PEACH
			)
			style.border_color = Color(0.87, 0.72, 0.62, 0.42)
			style.set_border_width_all(1)
		_:
			style.bg_color = (
				PEACH
				if state == &"pressed"
				else Color("#fffaf5") if state == &"hover" else CREAM
			)
			style.border_color = Color("#f3dfcf")
			style.set_border_width_all(1)
			style.shadow_color = Color(0.42, 0.25, 0.17, 0.1)
			style.shadow_size = 3 if state != &"pressed" else 1
			style.shadow_offset = Vector2(0.0, 3.0 if state != &"pressed" else 1.0)
	return style


static func _font_file(path: String) -> Font:
	if not _fonts.has(path):
		_fonts[path] = load(path)
	return _fonts[path]
