import { Component, Input } from '@angular/core';
import { NgClass } from '@angular/common';

/**
 * DeviceBezelComponent
 *
 * Renders a pure-CSS device frame (bezel) around projected content.
 *
 * - `platform="ios"` → iPhone 15 Pro style: titanium finish, Dynamic Island,
 *   side buttons (volume, power), bottom home indicator bar.
 * - `platform="android"` → Pixel 8 style: matte black, punch-hole front camera,
 *   minimal bezels.
 *
 * The projected content (e.g. a `<canvas>`) fills the screen area of the bezel.
 * The entire frame scales responsively via CSS — no fixed pixel dimensions are
 * imposed on the host; the bezel wraps its content.
 *
 * @example
 * ```html
 * <app-device-bezel [platform]="platform">
 *   <canvas class="display-canvas"></canvas>
 * </app-device-bezel>
 * ```
 */
@Component({
  selector: 'app-device-bezel',
  standalone: true,
  imports: [NgClass],
  templateUrl: './device-bezel.component.html',
  styleUrl: './device-bezel.component.scss',
})
export class DeviceBezelComponent {
  /**
   * Target platform — controls which device frame is rendered.
   * - `'ios'`     → iPhone 15 Pro
   * - `'android'` → Pixel 8
   */
  @Input() platform: 'ios' | 'android' = 'ios';
}
