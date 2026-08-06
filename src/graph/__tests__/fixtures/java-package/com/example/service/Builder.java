package com.example.service;

import com.example.models.Widget;

public class Builder {
  public Widget build() {
    Widget w = new Widget();
    w.touch();
    return w;
  }
}
