package com.example;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Widget {
  @Id
  private Long id;

  private String name;
}
