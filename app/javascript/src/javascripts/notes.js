import "jquery-ui/ui/widgets/draggable";
import "jquery-ui/ui/widgets/resizable";
import "jquery-ui/themes/base/draggable.css";
import "jquery-ui/themes/base/resizable.css";

import CurrentUser from './current_user';
import Utility, { clamp } from './utility';

class Note {
  static HIDE_DELAY = 250;
  static NORMALIZE_ATTRIBUTES = ['letter-spacing', 'line-height', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom'];
  static COPY_ATTRIBUTES = ['background-color', 'border-radius', 'transform', 'justify-content', 'align-items'];
  static RESIZE_HANDLES = "se, nw";

  // Notes must be at least 10x10 in size so they're big enough to drag and resize.
  static MIN_NOTE_SIZE = 10;

  static notes = new Set();
  static timeouts = [];

  id = null;
  box = null;
  body = null;
  $note_container = null;
  has_rotation = false;

  static Box = class {
    note = null;
    $note_box = null;
    $inner_border = null;

    constructor(note) {
      this.note = note;
      this.$note_box = $('<div class="note-box">');
      this.note.$note_container.append(this.$note_box);

      if (note.embed) {
        this.$note_box.addClass("embedded");
        this.$inner_border = $('<div class="note-box-inner-border">');
        this.$note_box.append(this.$inner_border);
      }

      if (this.note.is_new()) {
        this.$note_box.addClass("unsaved");
      }

      this.$note_box.draggable({
        containment: this.note.$note_container,
      });

      this.$note_box.resizable({
        containment: this.note.$note_container,
        handles: Note.RESIZE_HANDLES,
        minWidth: Note.MIN_NOTE_SIZE,
        minHeight: Note.MIN_NOTE_SIZE,
      });

      this.$note_box.on("click.danbooru", this.on_click.bind(this));
      this.$note_box.on("mouseenter.danbooru", this.on_mouseenter.bind(this));
      this.$note_box.on("mouseleave.danbooru", this.on_mouseleave.bind(this));
      this.$note_box.on("dragstart.danbooru resizestart.danbooru", this.on_dragstart.bind(this));
      this.$note_box.on("dragstop.danbooru resizestop.danbooru", this.on_dragstop.bind(this));
    }

    on_click() {
      if (!Utility.test_max_width(660)) {
        // Toggle selection status when note is clicked. Enable movement keys when note is selected.
        if (this.$note_box.hasClass("movable")) {
          this.$note_box.removeClass("movable");
          $(document).off("keydown.nudge_note");
          $(document).off("keydown.resize_note");
        } else {
          this.$note_box.addClass("movable");
          Utility.keydown("up down left right", "nudge_note", this.key_nudge.bind(this));
          Utility.keydown("shift+up shift+down shift+left shift+right", "resize_note", this.key_resize.bind(this));
        }
      } else if (this.$note_box.hasClass("viewing")) {
        this.note.body.hide();
        this.$note_box.removeClass("viewing");
      } else {
        $(".note-box").removeClass("viewing");
        this.note.body.show();
        this.$note_box.addClass("viewing");
      }
    }

    on_mouseenter() {
      this.note.body.show();
      this.$note_box.addClass("hovering");
    }

    on_mouseleave() {
      this.note.body.hide();
      this.$note_box.removeClass("hovering");
    }

    on_dragstart() {
      this.$note_box.addClass("unsaved");
      Note.Body.hide_all();
    }

    // Reset the note box placement after the box is dragged or resized. Dragging the note
    // changes the CSS coordinates to pixels, so we have to convert them back to percentages.
    on_dragstop() {
      this.place_note(this.note.x, this.note.y, this.note.width, this.note.height);
    }

    // Place the note box using absolute percentage coordinates (floats in the range 0.0..1.0).
    place_note(x, y, w, h) {
      if (this.note.embed && this.note.has_rotation) {
        let position = this.get_min_max_position();
        x = position.norm_left / this.note.image_width;
        y = position.norm_top / this.note.image_height;
      }

      x = clamp(x, 0.0, 1.0);
      y = clamp(y, 0.0, 1.0);
      w = clamp(w, Note.MIN_NOTE_SIZE / this.note.post_width, 1.0);
      h = clamp(h, Note.MIN_NOTE_SIZE / this.note.post_height, 1.0);

      this.$note_box.css({
        top: (100 * y) + '%',
        left: (100 * x) + '%',
        width: (100 * w) + '%',
        height: (100 * h) + '%',
      });
    }

    copy_style_attributes() {
      let $note_box = this.$note_box;
      let $attribute_child = $note_box.find('.note-box-attributes');
      let has_rotation = false;

      Note.COPY_ATTRIBUTES.forEach((attribute)=>{
        const attribute_value = this.permitted_style_values(attribute, $attribute_child);
        $note_box.css(attribute, attribute_value);

        if (attribute === "transform" && attribute_value.startsWith("rotate")) {
          has_rotation = true;
        }
      });

      if (has_rotation) {
        const current_left = Math.round(parseFloat($note_box.css("left")));
        const current_top = Math.round(parseFloat($note_box.css("top")));
        const position = this.get_min_max_position();

        // Checks for the scenario where the user sets invalid box values through the API
        // or by adjusting the box dimensions through the browser's dev console before saving
        if (current_left !== position.norm_left || current_top !== position.norm_top) {
          $note_box.css({
            top: position.percent_top,
            left: position.percent_left,
          });

          $note_box.addClass("out-of-bounds");
        } else {
          $note_box.removeClass("out-of-bounds");
        }

        this.note.has_rotation = true;
      } else {
        this.note.has_rotation = false;
      }
    }

    permitted_style_values(attribute, $attribute_child) {
      if ($attribute_child.length === 0) {
        return "";
      }

      let found_attribute = $attribute_child.attr('style').split(';').filter(val => val.match(RegExp(`(^| )${attribute}:`)));
      if (found_attribute.length === 0) {
        return "";
      }

      let [, value] = found_attribute[0].trim().split(':').map(val => val.trim());
      if (attribute === "background-color") {
        const color_code = $attribute_child.css('background-color');
        return color_code.startsWith('rgba') ? "" : value;
      }

      if (attribute === "transform") {
        let rotate_match = value.match(/rotate\([^)]+\)/);
        return rotate_match ? rotate_match[0] : "";
      }

      return value;
    }

    key_nudge(event) {
      let $note_box = this.note.box.$note_box;

      let current_top = Math.round($note_box.position().top);
      let current_left = Math.round($note_box.position().left);

      switch (event.originalEvent.key) {
      case "ArrowUp":
        current_top--;
        break;
      case "ArrowDown":
        current_top++;
        break;
      case "ArrowLeft":
        current_left--;
        break;
      case "ArrowRight":
        current_left++;
        break;
      default:
        // do nothing
      }

      let position = this.get_min_max_position(current_top, current_left);
      $note_box.css({
        top: position.percent_top,
        left: position.percent_left,
      });

      $note_box.addClass("unsaved");
      event.preventDefault();
    }

    key_resize(event) {
      let $note_box = this.note.box.$note_box;

      let current_top = Math.round($note_box.position().top);
      let current_left = Math.round($note_box.position().left);
      let current_height = $note_box.height();
      let current_width = $note_box.width();

      switch (event.originalEvent.key) {
      case "ArrowUp":
        current_height--;
        break;
      case "ArrowDown":
        current_height++;
        break;
      case "ArrowLeft":
        current_width--;
        break;
      case "ArrowRight":
        current_width++;
        break;
      default:
        // do nothing
      }

      const position = this.get_min_max_position(null, null, current_height, current_width);
      if (current_top === position.norm_top && current_left === position.norm_left) {
        $note_box.css({
          height: current_height,
          width: current_width,
        });
      }

      $note_box.addClass("unsaved");
      event.preventDefault();
    }

    get_min_max_position(current_top = null, current_left = null, current_height = null, current_width = null) {
      let $note_box = this.$note_box;
      const computed_style = window.getComputedStyle($note_box[0]);

      current_top = (current_top === null ? parseFloat(computed_style.top) : current_top);
      current_left = (current_left === null ? parseFloat(computed_style.left) : current_left);
      current_height = current_height || $note_box.height();
      current_width = current_width || $note_box.width();

      const image_height = this.note.image_height;
      const image_width = this.note.image_width;
      const box_data = this.get_bounding_box(current_height, current_width);

      if (((box_data.max_x - box_data.min_x) <= image_width) && ((box_data.max_y - box_data.min_y) <= image_height)) {
        current_top = Math.min(Math.max(current_top, -box_data.min_y, 0), image_height - box_data.max_y - 2, image_height - box_data.min_y - box_data.max_y - 2, image_height);
        current_left = Math.min(Math.max(current_left, -box_data.min_x, 0), image_width - box_data.max_x - 2, image_width - box_data.min_x - box_data.max_x - 2, image_width);
      } else {
        Utility.error("Box too large to be rotated!");
        $note_box.css('transform', 'none');
      }

      return {
        norm_top: Math.round(current_top),
        norm_left: Math.round(current_left),
        percent_top: (100 * (current_top / image_height)) + '%',
        percent_left: (100 * (current_left / image_width)) + '%',
      };
    }

    get_bounding_box(height = null, width = null) {
      let $note_box = this.$note_box;
      height = height || $note_box.height();
      width = width || $note_box.width();
      let old_coord = [[0, 0], [width, 0], [0, height], [width, height]];
      const computed_style = window.getComputedStyle($note_box[0]);
      const match = computed_style.transform.match(/matrix\(([-e0-9.]+), ([-e0-9.]+)/);

      if (!match) {
        return {
          min_x: 0,
          min_y: 0,
          max_x: width,
          max_y: height,
          norm_coord: old_coord,
          degrees: 0,
        }
      }

      const costheta = Math.round(match[1] * 1000) / 1000;
      const sintheta = Math.round(match[2] * 1000) / 1000;
      let trans_x = width / 2;
      let trans_y = height / 2;
      let min_x = Infinity;
      let max_x = 0;
      let min_y = Infinity;
      let max_y = 0;

      const new_coord = old_coord.map((coord)=>{
        let temp_x = coord[0] - trans_x;
        let temp_y = coord[1] - trans_y;
        let rotated_x = (temp_x * costheta) - (temp_y * sintheta);
        let rotated_y = (temp_x * sintheta) + (temp_y * costheta);
        let new_x = rotated_x + trans_x;
        let new_y = rotated_y + trans_y;
        min_x = Math.min(min_x, new_x);
        max_x = Math.max(max_x, new_x);
        min_y = Math.min(min_y, new_y);
        max_y = Math.max(max_y, new_y);
        return [new_x, new_y];
      });

      const norm_coord = new_coord.map((coord)=>{
        return [coord[0] - min_x, coord[1] - min_y];
      });

      const radians_per_degree = 0.017453292519943295;
      const degrees = Math.asin(sintheta) / radians_per_degree;

      return {
        min_x: min_x,
        min_y: min_y,
        max_x: max_x,
        max_y: max_y,
        norm_coord: norm_coord,
        degrees: degrees,
      };
    }

    show_highlighted() {
      this.note.body.show();
      $(".note-box-highlighted").removeClass("note-box-highlighted");
      this.$note_box.addClass("note-box-highlighted");
      this.$note_box[0].scrollIntoView(false);
    }

    // Rescale font sizes of embedded notes when the image is resized.
    static scale_all() {
      let $image = $("#image");
      let $container = $(".note-container");

      if ($container.length === 0) {
        return;
      }

      let large_width = parseFloat($image.data('large-width'));
      let ratio = $image.width() / large_width;
      let font_percentage = ratio * 100;

      $container.css('font-size', font_percentage + '%');
    }

    static toggle_all() {
      Note.Body.hide_all();
      $(".note-container").toggleClass("hide-notes");
    }
  }

  static Body = class {
    note = null;
    $note_body = null;

    constructor(note) {
      this.note = note;
      this.$note_body = $('<div class="note-body"/>');
      this.note.$note_container.append(this.$note_body);

      this.$note_body.on("mouseover.danbooru", this.on_mouseover.bind(this));
      this.$note_body.on("mouseout.danbooru", this.on_mouseout.bind(this));
      this.$note_body.on("click.danbooru", this.on_click.bind(this));
    }

    initialize() {
      let $note_body = this.$note_body;
      let $note_box = this.note.box.$note_box;

      if (this.note.embed && this.note.has_rotation) {
        const box_data = this.note.box.get_bounding_box();
        // Select the lowest box corner to the farthest left
        let selected_corner = box_data.norm_coord.reduce(function (selected, coord) {return (selected[1] > coord[1]) || (selected[1] === coord[1] && selected[0] < coord[0]) ? selected : coord;});
        let normalized_degrees = box_data.degrees % 90.0;
        // Align to the left or right body corner depending upon the box angle
        let body_corner = $note_box.position().left - (normalized_degrees > 0.0 && normalized_degrees <= 45.0 ? $note_body.width() : 0);

        $note_body.css({
          top: $note_box.position().top + selected_corner[1] + 5,
          left: body_corner + selected_corner[0],
        });
      } else {
        $note_body.css({
          top: $note_box.position().top + $note_box.height() + 5,
          left: $note_box.position().left,
        });
      }

      this.bound_position();
    }

    bound_position() {
      var $image = this.note.$note_container;
      var doc_width = $image.offset().left + $image.width();
      let $note_body = this.$note_body;

      if ($note_body.offset().left + $note_body.width() > doc_width) {
        $note_body.css({
          left: $note_body.position().left - 10 - ($note_body.offset().left + $note_body.width() - doc_width)
        });
      }
    }

    show() {
      Note.Body.hide_all();

      if (!this.resized) {
        this.resize();
        this.resized = true;
      }

      this.$note_body.show();
      this.initialize();
    }

    hide(delay = Note.HIDE_DELAY) {
      Note.timeouts.push(setTimeout(() => this.$note_body.hide(), delay));
    }

    static hide_all() {
      Note.timeouts.forEach(clearTimeout);
      Note.timeouts = [];
      $(".note-container div.note-body").hide();
    }

    resize() {
      let $note_body = this.$note_body;

      $note_body.css("min-width", "");
      var w = $note_body.width();
      var h = $note_body.height();
      var golden_ratio = 1.6180339887;
      var last = 0;
      var x = 0;
      var lo = 0;
      var hi = 0;

      if ((w / h) < golden_ratio) {
        lo = 140;
        hi = 400;

        do {
          last = w;
          x = (lo + hi) / 2;
          $note_body.css("min-width", x);
          w = $note_body.width();
          h = $note_body.height();

          if ((w / h) < golden_ratio) {
            lo = x;
          } else {
            hi = x;
          }
        } while ((lo < hi) && (w > last));
      } else if ($note_body[0].scrollWidth <= $note_body.width()) {
        lo = 20;
        hi = w;

        do {
          x = (lo + hi) / 2;
          $note_body.css("min-width", x);
          if ($note_body.height() > h) {
            lo = x
          } else {
            hi = x;
          }
        } while ((hi - lo) > 4);
        if ($note_body.height() > h) {
          $note_body.css("min-width", hi);
        }
      }
    }

    display_text(text) {
      this.set_text(text);

      if (this.note.embed) {
        let $note_inner_box = this.note.box.$inner_border;

        // Reset the font size so that the normalization calculations will be correct
        $note_inner_box.css("font-size", this.note.base_font_size + "px");
        this.note.normalize_sizes($note_inner_box.children(), this.note.base_font_size);

        // Clear the font size so that the fonts will be scaled to the current value
        $note_inner_box.css("font-size", "");
        this.note.box.copy_style_attributes();
      }

      this.resize();
      this.bound_position();
    }

    set_text(text) {
      text = text ?? "";
      text = text.replace(/<tn>/g, '<p class="tn">');
      text = text.replace(/<\/tn>/g, '</p>');
      text = text.replace(/\n/g, '<br>');

      if (this.note.embed) {
        this.note.box.$inner_border.html(text);
        this.$note_body.html("<em>Click to edit</em>");
      } else if (text) {
        this.$note_body.html(text);
      } else {
        this.$note_body.html("<em>Click to edit</em>");
      }
    }

    async preview_text(text) {
      this.display_text("Loading...");
      let response = await $.getJSON("/note_previews", { body: text });

      this.display_text(response.body);
      this.initialize();
      this.$note_body.show();
    }

    on_mouseover(e) {
      this.show();
    }

    on_mouseout() {
      this.hide();
    }

    on_click(e) {
      // don't open the note edit dialog when the user clicks a link in the note body.
      if ($(e.target).is("a")) {
        return;
      }

      if (CurrentUser.data("is-anonymous")) {
        Utility.notice("You must be logged in to edit notes");
      } else {
        Note.Edit.show(this.note);
      }
    }
  }

  static Edit = class {
    static show(note) {
      if ($(".note-box").hasClass("editing")) {
        return;
      }

      let $textarea = $('<textarea></textarea>');
      $textarea.val(note.original_body);
      $textarea.css({
        width: "97%",
        height: "85%",
        resize: "none",
      });

      let $dialog = $('<div></div>');
      let note_title = note.is_new() ? 'Creating new note' : `Editing note #${note.id}`;

      $dialog.append('<span><b>' + note_title + ' (<a href="/wiki_pages/help:notes">view help</a>)</b></span>');
      $dialog.append($textarea);

      $dialog.dialog({
        width: 360,
        height: 240,
        position: {
          my: "right",
          at: "right-20",
          of: window
        },
        classes: {
          "ui-dialog": "note-edit-dialog",
        },
        open: () => {
          Utility.keydown("ctrl+return", "save_note", () => this.save($dialog, note), ".note-edit-dialog textarea");
          $(".note-edit-dialog textarea").on("input.danbooru", (e) => this.on_input(note));
          $(".note-box").addClass("editing");
        },
        close: () => {
          $(".note-box").removeClass("editing");
        },
        buttons: {
          "Save": () => Note.Edit.save($dialog, note),
          "Preview": () => Note.Edit.preview($dialog, note),
          "Cancel": () => Note.Edit.cancel($dialog, note),
          "Delete": () => Note.Edit.destroy($dialog, note),
          "History": () => Note.Edit.history($dialog, note),
        }
      });

      $textarea.selectEnd();
    }

    static on_input(note) {
      note.box.$note_box.addClass("unsaved");
    }

    static async save($dialog, note) {
      let $note_box = note.box.$note_box;
      let text = $dialog.find("textarea").val();

      let params = {
        x: Math.round(note.x * note.post_width),
        y: Math.round(note.y * note.post_height),
        width: Math.round(note.width * note.post_width),
        height: Math.round(note.height * note.post_height),
        body: text
      };

      note.original_body = text;
      note.body.preview_text(text);

      try {
        if (note.is_new()) {
          params.post_id = note.post_id;
          let response = await $.ajax("/notes.json", { type: "POST", data: { note: params }});
          note.id = response.id;
        } else {
          await $.ajax(`/notes/${note.id}.json`, { type: "PUT", data: { note: params }});
        }

        $dialog.dialog("close");
        $note_box.removeClass("unsaved");
      } catch (xhr) {
        Utility.error("Error: " + (xhr.responseJSON.reason || xhr.responseJSON.reasons.join("; ")));
      }
    }

    static async preview($dialog, note) {
      let text = $dialog.find("textarea").val();
      note.body.preview_text(text);
    }

    static cancel($dialog, _note) {
      $dialog.dialog("close");
    }

    static async destroy($dialog, note) {
      if (!note.is_new() && !confirm("Do you really want to delete this note?")) {
        return;
      }

      if (!note.is_new()) {
        await $.ajax(`/notes/${note.id}.json`, { type: "DELETE" });
      }

      note.box.$note_box.remove();
      note.body.$note_body.remove();
      Note.notes.delete(note);

      $dialog.dialog("close");
    }

    static history($dialog, note) {
      if (!note.is_new()) {
        window.location.href = `/note_versions?search[note_id]=${note.id}`;
      }

      $dialog.dialog("close");
    }
  }

  static TranslationMode = class {
    static toggle() {
      if ($("body").hasClass("mode-translation")) {
        Note.TranslationMode.stop();
      } else {
        Note.TranslationMode.start();
      }
    }

    static start() {
      $(document.body).addClass("mode-translation");
      $("#image").off("click.danbooru", Note.Box.toggle_all);
      $("#image").on("mousedown.danbooru.note", Note.TranslationMode.Drag.start);

      Utility.notice('Translation mode is on. Drag on the image to create notes. <a href="#">Turn translation mode off</a> (shortcut is <span class="key">n</span>).');
      $("#notice a:contains(Turn translation mode off)").on("click.danbooru", Note.TranslationMode.stop);
    }

    static stop() {
      $("#note-preview").hide();
      $("#image").on("click.danbooru", Note.Box.toggle_all);
      $("#image").off("mousedown.danbooru.note", Note.TranslationMode.Drag.start);
      $(document).off("mouseup.danbooru", Note.TranslationMode.Drag.stop);
      $(document).off("mousemove.danbooru", Note.TranslationMode.Drag.drag);
      $(document.body).removeClass("mode-translation");
      $("#close-notice-link").click();
    }

    static Drag = class {
      static dragStartX = 0;
      static dragStartY = 0;

      static start(e) {
        if (e.which !== 1) {
          return;
        }

        e.preventDefault(); /* don't drag the image */
        $(document).on("mousemove.danbooru", Note.TranslationMode.Drag.drag);
        $(document).on("mouseup.danbooru", Note.TranslationMode.Drag.stop);
        Note.TranslationMode.Drag.dragStartX = e.pageX;
        Note.TranslationMode.Drag.dragStartY = e.pageY;
      }

      static drag(e) {
        var $image = $("#image");
        var offset = $image.offset();

        // (x0, y0) is the top left point of the drag box. (x1, y1) is the bottom right point.
        let x0 = clamp(e.pageX, offset.left, Note.TranslationMode.Drag.dragStartX);
        let y0 = clamp(e.pageY, offset.top, Note.TranslationMode.Drag.dragStartY);
        let x1 = clamp(e.pageX, Note.TranslationMode.Drag.dragStartX, offset.left + $image.width());
        let y1 = clamp(e.pageY, Note.TranslationMode.Drag.dragStartY, offset.top + $image.height());

        // Convert from page-relative coordinates to image-relatives coordinates.
        let x = x0 - offset.left;
        let y = y0 - offset.top;
        let w = x1 - x0;
        let h = y1 - y0;

        // Only show the new note box after we've dragged a minimum distance. This is to avoid
        // accidentally creating tiny notes if we drag a small distance while trying to toggle notes.
        if (w >= Note.MIN_NOTE_SIZE || h >= Note.MIN_NOTE_SIZE) {
          $("#note-preview").show();
        }

        if ($("#note-preview").is(":visible")) {
          $('#note-preview').css({ left: x, top: y, width: w, height: h });
        }
      }

      static stop() {
        $(document).off("mousemove.danbooru", Note.TranslationMode.Drag.drag);
        $(document).off("mouseup.danbooru", Note.TranslationMode.Drag.stop);

        if ($("#note-preview").is(":visible")) {
          let $image = $("#image");

          new Note({
            x: $("#note-preview").position().left / $image.width(),
            y: $("#note-preview").position().top / $image.height(),
            w: $("#note-preview").width() / $image.width(),
            h: $("#note-preview").height() / $image.height(),
          });

          $("#note-preview").hide();
          $(".note-container").removeClass("hide-notes");
        } else { /* If we didn't drag far enough, treat it as a click and toggle displaying notes. */
          Note.Box.toggle_all();
        }
      }
    }
  }

  constructor({ x, y, w, h, id = null, original_body = null, sanitized_body = null } = {}) {
    this.$note_container = $(".note-container");

    this.id = id;
    this.post_id = this.$note_container.data("id");
    this.embed = Utility.meta("post-has-embedded-notes") === "true";
    this.original_body = original_body;

    this.box = new Note.Box(this);
    this.body = new Note.Body(this);

    this.box.place_note(x, y, w, h);
    this.body.display_text(sanitized_body);

    Note.notes.add(this);
  }

  is_new() {
    return this.id === null;
  }

  // The coordinates of the top left corner of the note box, as floats in the
  // range 0.0 to 1.0. Does not account for note rotation.
  get x() {
    return this.box.$note_box.position().left / this.image_width;
  }

  get y() {
    return this.box.$note_box.position().top / this.image_height;
  }

  // The current width and height of the note box, as floats in the range 0.0 to 1.0.
  get width() {
    return this.box.$note_box.width() / this.image_width;
  }

  get height() {
    return this.box.$note_box.height() / this.image_height;
  }

  // The width and height of the full-size original image in pixels.
  get post_width() {
    return parseInt(this.$note_container.attr("data-width"));
  }

  get post_height() {
    return parseInt(this.$note_container.attr("data-height"));
  }

  // The current width and height of the image in pixels. Will be smaller than the post width
  // if the sample image is being displayed, or if the image is resized to fit the screen.
  get image_width() {
    return parseInt(this.$note_container.width());
  }

  get image_height() {
    return parseInt(this.$note_container.height());
  }

  // The initial font size of the note container. Embedded notes are scaled relative to this value.
  get base_font_size() {
    return parseFloat(this.$note_container.parent().css("font-size"));
  }

  normalize_sizes($note_elements, parent_font_size) {
    if ($note_elements.length === 0) {
      return;
    }

    $note_elements.toArray().forEach((element) => {
      const $element = $(element);
      const computed_styles = window.getComputedStyle(element);
      const font_size = parseFloat(computed_styles.fontSize);

      Note.NORMALIZE_ATTRIBUTES.forEach((attribute) => {
        const original_size = parseFloat(computed_styles[attribute]) || 0;
        const relative_em = original_size / font_size;
        $element.css(attribute, relative_em + "em");
      });

      const font_percentage = 100 * (font_size / parent_font_size);
      $element.css("font-size", font_percentage + "%");
      $element.attr("size", "");

      this.normalize_sizes($element.children(), font_size);
    });
  }

  static find(id) {
    return Array.from(Note.notes).find(note => note.id === id);
  }

  static load_all() {
    let $image = $(".image-container");

    $("#notes article").toArray().forEach(article => {
      var $article = $(article);

      new Note({
        id: $article.data("id"),
        x: $article.data("x") / $image.data("width"),
        y: $article.data("y") / $image.data("height"),
        w: $article.data("width") / $image.data("width"),
        h: $article.data("height") / $image.data("height"),
        original_body: $article.data("body"),
        sanitized_body: $article.html()
      });
    });
  }

  static initialize_all() {
    if ($("#c-posts #a-show #image").length === 0 || $("video#image").length) {
      return;
    }

    Note.load_all();
    Note.Box.scale_all();

    $(document).on("click.danbooru", "#translate", (e) => {
      Note.TranslationMode.toggle();
      e.preventDefault();
    });

    this.initialize_highlight();
    $(document).on("hashchange.danbooru.note", this.initialize_highlight);

    $(window).on("resize.danbooru.note_scale", Note.Box.scale_all);
    $("#image").on("click.danbooru", Note.Box.toggle_all);
  }

  static initialize_highlight() {
    var matches = window.location.hash.match(/^#note-(\d+)$/);

    if (matches) {
      let note_id = parseInt(matches[1]);
      let note = Note.find(note_id);
      note.box.show_highlighted();
    }
  }
}

$(function() {
  Note.initialize_all();
});

export default Note

