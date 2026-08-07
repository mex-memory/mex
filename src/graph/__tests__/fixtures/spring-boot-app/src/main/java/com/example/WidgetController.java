package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class WidgetController {
  private final WidgetService service;

  public WidgetController(WidgetService service) {
    this.service = service;
  }

  @GetMapping("/widgets")
  public String list() {
    return service.list();
  }
}
