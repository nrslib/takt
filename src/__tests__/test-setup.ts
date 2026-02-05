if (process.env.TAKT_TEST_FLG_TOUCH_TTY !== '1') {
  process.env.TAKT_NO_TTY = '1';
}
